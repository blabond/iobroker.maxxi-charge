'use strict';

const utils = require('@iobroker/adapter-core');
const { ensureStateExists, validateInterval } = require('./utils'); // utils importieren
const Commands = require('./commands');
const LocalApi = require('./localApi');
const CloudApi = require('./cloudApi');
const EcoMode = require('./ecoMode'); // EcoMode importieren

class MaxxiCharge extends utils.Adapter {
	constructor(options) {
		super({
			...options,
			name: 'maxxi-charge',
		});

		this.on('ready', this.onReady.bind(this));
		this.on('unload', this.onUnload.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));

		this.activeDevices = {}; // Speichert aktive CCUs
		this.commands = new Commands(this); // Initialisiere Commands
		this.localApi = new LocalApi(this); // Initialisiere LocalApi
		this.cloudApi = null; // Platzhalter für CloudApi, wird in onReady initialisiert
		this.ecoMode = new EcoMode(this); // Initialisiere EcoMode

		this.maxxiccuname = ''; // Platzhalter, wird in onReady gesetzt
		this.stateCache = new Set(); // Cache für vorhandene States
	}

	async onReady() {
		try {
			// IP-Adresse des Hosts ermitteln
			const hostObject = await this.getForeignObjectAsync(`system.host.${this.host}`);
			let ipAddress = "ioBroker IP"; // Fallback

			if (hostObject?.native?.hardware?.networkInterfaces) {
				const networkInterfaces = hostObject.native.hardware.networkInterfaces;

				for (const ifaceName in networkInterfaces) {
					const iface = networkInterfaces[ifaceName];
					for (const address of iface) {
						if (!address.internal && address.family === 'IPv4') {
							ipAddress = address.address;
							break;
						}
					}
					if (ipAddress !== "ioBroker IP") break;
				}
			}

			await ensureStateExists(this, this.stateCache, `${this.namespace}.info.localip`, {
				type: 'state',
				common: {
					name: 'Local IP Address',
					type: 'string',
					role: 'info.ip',
					read: true,
					write: false,
				},
				native: {},
			});

			await this.setStateAsync(`${this.namespace}.info.localip`, { val: ipAddress, ack: true });
			this.log.debug(`Local IP address determined and cached: ${ipAddress}`);

			// Setze info.connection und info.aktivCCU auf Standardwerte
			await this.setObjectNotExistsAsync('info.connection', {
				type: 'state',
				common: {
					name: {
						en: 'Connection active',
						de: 'Verbindung aktiv',
					},
					type: 'boolean',
					role: 'indicator.connected',
					read: true,
					write: false,
				},
				native: {},
			});

			await this.setObjectNotExistsAsync('info.aktivCCU', {
				type: 'state',
				common: {
					name: {
						en: 'Active CCUs',
						de: 'Aktive CCUs',
					},
					type: 'string',
					role: 'value',
					read: true,
					write: false,
				},
				native: {},
			});

			await this.setStateAsync('info.connection', { val: false, ack: true });
			await this.setStateAsync('info.aktivCCU', { val: '', ack: true });

			// Initialisiere APIs basierend auf dem Modus
			this.cloudApi = new CloudApi(this);

			if (this.config.apimode === 'local') {
				await this.localApi.init();
			} else if (this.config.apimode === 'cloud') {
				await this.cloudApi.init();
			}

			// Cleanup-Intervall
			this.cleanupInterval = this.setInterval(() => this.cleanupActiveDevices(), validateInterval(2 * 60 * 1000));

			// EcoMode initialisieren, falls aktiviert
			if (this.config.enableseasonmode) {
				this.ecoMode = new EcoMode(this);
				await this.ecoMode.init();
			}
		} catch (error) {
			this.log.error(`Fatal error during initialization: ${error.message}`);
		}
	}

	async onStateChange(id, state) {
		if (!state || state.ack) return;

		if (id === `${this.namespace}.info.connection`) {
			if (state.val === true) {
				await this.ecoMode.startMonitoring();
			} else {
				this.ecoMode.cleanup();
			}
		}

		if (id.endsWith('.SOC')) {
			await this.ecoMode.handleSOCChange(id, state);
		}

		await this.commands.handleCommandChange(id, state);
	}

	async updateActiveCCU(deviceId) {
		const now = Date.now();
		this.activeDevices[deviceId] = now;

		const keys = Object.keys(this.activeDevices);
		const csv = keys.join(',');

		const currentConnectionState = await this.getStateAsync('info.connection');
		if (!currentConnectionState?.val) {
			await this.setStateAsync('info.aktivCCU', { val: csv, ack: true });
			await this.setStateAsync('info.connection', { val: keys.length > 0, ack: true });
		}
	}

	async cleanupActiveDevices() {
		const now = Date.now();
		const fiveMinAgo = now - 5 * 60 * 1000;

		for (const deviceId in this.activeDevices) {
			if (this.activeDevices[deviceId] < fiveMinAgo) {
				delete this.activeDevices[deviceId];
				this.log.info(`Device ${deviceId} marked as inactive and removed.`);
			}
		}

		const keys = Object.keys(this.activeDevices);
		await this.setStateAsync('info.aktivCCU', { val: keys.join(','), ack: true });
		await this.setStateAsync('info.connection', { val: keys.length > 0, ack: true });
	}

	async onUnload(callback) {
		try {
			await this.setStateAsync('info.connection', { val: false, ack: true });
			await this.setStateAsync('info.aktivCCU', { val: '', ack: true });

			if (this.ecoMode) this.ecoMode.cleanup();
			if (this.localApi) this.localApi.cleanup();
			if (this.cloudApi) this.cloudApi.cleanup();

			// Alle Timer und Intervalle korrekt aufräumen
			this.clearInterval(this.cleanupInterval);
			this.log.info('MaxxiCharge adapter terminated.');
			callback();
		} catch (e) {
			this.log.error(`Error during shutdown: ${e.message}`);
			callback();
		}
	}
}

if (require.main !== module) {
	module.exports = (options) => new MaxxiCharge(options);
} else {
	new MaxxiCharge();
}
