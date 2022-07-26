/*
 * Created with @iobroker/create-adapter v2.1.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
'use strict';
const utils = require('@iobroker/adapter-core');
const api = require('./solarmanpvApiClient.js');

class Solarmanpv extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: 'solarmanpv',
		});

		this.on('ready', this.onReady.bind(this));
		this.on('unload', this.onUnload.bind(this));
		api.eventEmitter.on('tokenChanged', this.onTokenChanged.bind(this));
		//
		this.stationList = [];
	}

	/**
	 * Is called when ApiClient has received new token.
	 */
	onTokenChanged(token) {
		this.log.debug('[onReady] token changed: ' + token);
		this.extendForeignObject('system.adapter.' + 'solarmanpv', {
			native: {
				aktiveToken: token
			}
		});
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here
		this.log.debug(`[onReady] started`);

		if (!this.config.email || !this.config.password) {
			this.log.error(`User email and/or user password empty - please check instance configuration`);
			return;
		}

		if (!this.config.appId || !this.config.appSecret) {
			this.log.error(`Solarman APP ID and/or APP Secrets empty - please check instance configuration`);
			return;
		}

		api.email = this.config.email;
		api.password = this.config.password;
		api.appId = this.config.appId;
		api.appSecret = this.config.appSecret;

		const object = await this.getForeignObjectAsync('system.adapter.solarmanpv');
		if (typeof(object) !== 'undefined' && object !== null){
			api.token = object.native.aktiveToken;
			this.log.debug('[onReady] intern token: ' + api.token);
		}

		// start with shift
		await this.shift(1000);
		console.log('==== TRY ====');

		try {
			// get station-id via api-call
			await this.initializeStation().then(result =>
				this.updateStationData(result));

			for (const station of this.stationList) {
				await this.initializeInverter(station).then(inverterList => {
					for (const inverter of inverterList) {
						this.getDeviceData(inverter.deviceId, inverter.deviceSn).then(data =>
							this.updateDeviceData(station, inverter.deviceId, data));
					}
				});
			}
		}
		catch (error) {
			this.log.error(`[onReady] error: ${error}`);
			this.log.debug(JSON.stringify(error));
		}
		finally {
			this.log.debug(`[onReady] finished - stopping instance`);
			if(typeof this.stop === 'function') {
				this.stop();
			}
		}
	// End onReady
	}
	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			this.log.debug('[callback] cleaned everything up...');
			callback();
		} catch (e) {
			callback();
			this.log.error('callback catch');
		}
	}

	async persistData(station, device, name, description, value, role, unit) {
		const dp_Device = station +'.'+ device +'.'+ name;
		const sensorName = device +'.'+ description;
		//this.log.debug(`[persistData] Station "${station}" Device "${dp_Device}" sensor "${description}" with value: "${value}" and unit "${unit}" as role "${role}`);
		await this.setObjectNotExistsAsync(station +'.'+ device, {
			type: 'device',
			common: {
				name: device
			},
			native: {}
		});
		/*
			await this.extendObjectAsync(Device, {
				common: {
					name: sensorName
				}
						});
		*/
		// Type-Erkennung
		let	_type = 'string';
		if (isNumeric(value)) {
			_type = 'number';
			value = parseFloat(value);
		}
		if (typeof value === 'object') {
			_type = 'string';
			console.log ('OBJECT');
			value = JSON.stringify(value);
		}

		await this.setObjectNotExistsAsync(dp_Device, {
			type: 'state',
			common: {
				name: sensorName,
				role: role,
				type: _type,
				// @ts-ignore
				unit: unit,
				read: true,
				write: false
			},
			native: {}
		});

		await this.setStateAsync(dp_Device, {val: value, ack: true});

		// Beschreibe diese Funktion: Prüfen ob Wert numerisch ist
		function isNumeric(n) {
			return !isNaN(parseFloat(n)) && isFinite(n);
		}
	}

	// update inverter data in ioBroker
	async updateDeviceData(stationId, deviceId, data) {
		// define keys that shall be updated (works in dataList only)
		const updateKeys = ['DV1','DV2','DC1','DC2','DP1','DP2','AV1','Et_ge0','Etdy_ge0','AC_RDT_T1','APo_t1'];
		const values = data.dataList.filter((obj) => updateKeys.includes(obj.key));
		values.forEach((obj) => {
			if (obj.value != 0) {
				//this.log.info('[updateDeviceData] '+ obj.key + ' Data: ' + obj.value + ' Unit: ' + obj.unit + ' Name: ' + obj.name);
				this.persistData(stationId, deviceId, obj.key, obj.name, obj.value, 'state', obj.unit);
			}
		});
	}

	// update station data in ioBroker
	updateStationData(data) {
		for (const obj of data) {
			let stationId;
			// define keys that shall be updated
			const updateKeys = [['id', 'state', ''],
				['name', 'state', ''],
				['generationPower','state', 'W'],
				['networkStatus','state',''],
				['lastUpdateTime','date', '']];

			updateKeys.forEach(key => {
				if (key[0] == 'id') { 		// special case 'id'
					stationId = obj[key[0]];
					this.stationList.push(stationId);		// StationId's for devices
				} else {
					if (key[0] == 'lastUpdateTime') { 		// special case 'lastUpdateTime'
						obj[key[0]] *= 1000;
					}
					//this.log.info('[updateStationData] '+ stationId  +' Name: '+ key[0] +' Data: '+ obj[key[0]] +' Role: '+ key[1] +' Unit: '+ key[2]);
					this.persistData(stationId, 'StationData', key[0], key[0], obj[key[0]], key[1], key[2]);
				}
			});
		}
	}

	// get inverter data from api
	async getDeviceData(deviceId, deviceSn) {
		this.log.debug(`[getDeviceData] Device ID >: ${deviceId} and Device SN >: ${deviceSn}`);

		return api.axios
			.post(
				'/device/v1.0/currentData?language=en', // language parameter does not show any effect
				{
					deviceId: deviceId,
					deviceSn: deviceSn
				}
			)
			.then((response) => {
				return response.data;
			})
			.catch((error) => {
				this.log.warn(`[getDeviceData] error: ${error}`);
				return Promise.reject(error);
			});

	}

	// get inverter-id from api
	async initializeInverter(stationId) {
		this.log.debug(`[initializeInverter] StationID >: ${stationId}`);
		return api.axios
			.post(
				'/station/v1.0/device?language=en', // language parameter does not show any effect
				{
					page: 1,
					size: 10,
					deviceType: 'MICRO_INVERTER',
					stationId : stationId
				}
			)
			.then((response) => {
				return(response.data.deviceListItems);
			})
			.catch((error) => {
				this.log.warn(`[initializeInverter] error: ${error}`);
				return Promise.reject(error);
			});
	}

	// get station-id from api (multiple)
	initializeStation() {
		return api.axios
			.post(
				'/station/v1.0/list?language=en', // language parameter does not show any effect
				{
					page: 1,
					size: 20
				}
			)
			.then((response) => {
				return response.data.stationList;
			})
			.catch((error) => {
				this.log.warn(`[initializeStation] error: ${error}`);
				console.log(error);
				return Promise.reject(error);
			});
	}

	// Start shift for api-call
	shift(msmin) {
		const ms = Math.floor(Math.random() * 5 * msmin + msmin);
		this.log.debug('[onReady] Start shift with ' + ms + ' ms');
		return new Promise(resolve => setTimeout(resolve, ms));
	}
// End Class
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Solarmanpv(options);
} else {
	// otherwise start the instance directly
	new Solarmanpv();
}