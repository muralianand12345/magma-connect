import { Plugin, Manager, NodeOptions, PlayerOptions } from 'magmastream';

/**
 * Geographic coordinate in decimal degrees.
 */
type LatLon = { lat: number; lon: number };

/**
 * Options for the MagmaConnect plugin.
 */
export interface MagmaConnectOptions {
	/**
	 * Optional explicit node locations keyed by node identifier (or host if no identifier).
	 * If provided, avoids calling public geo APIs for those nodes.
	 */
	nodeLocations?: Record<string, LatLon | { region: string }>;
	/**
	 * Optional provider to supply a guild's approximate location or region code.
	 * If omitted, the plugin uses Discord voice region hints and falls back to the bot host geo.
	 */
	getGuildLocation?: (guildId: string) => Promise<LatLon | { region: string } | undefined>;
	/**
	 * Interval (ms) to periodically refresh node geolocation. Disable by leaving undefined/0.
	 */
	refreshIntervalMs?: number;
	/**
	 * Enables debug logging prefixed with [MagmaConnect].
	 */
	debug?: boolean;
}

/**
 * Plugin that selects the nearest Lavalink node per guild using regional/geographic hints.
 *
 * It intercepts Manager.create (when nodeIdentifier is omitted) and chooses the closest node
 * based on cached guild region, user-provided guild resolver, or the bot host location.
 */
export class MagmaConnect extends Plugin {
	private readonly options: MagmaConnectOptions;
	private manager?: Manager;
	private interval?: NodeJS.Timeout;
	private originalCreate?: Manager['create'];
	private originalUpdateVoiceState?: Manager['updateVoiceState'];

	private nodeGeo = new Map<string, LatLon>();
	private guildGeo = new Map<string, LatLon>();
	private selfGeo?: LatLon; // Bot host geolocation as a fallback

	/**
	 * Creates a new MagmaConnect plugin instance.
	 * @param options Plugin configuration.
	 */
	public constructor(options: MagmaConnectOptions = {}) {
		super('MagmaConnect');
		this.options = options;
	}

	/**
	 * Loads the plugin: caches manager reference, starts node geo refresh, and patches Manager methods.
	 * @param manager MagmaStream Manager instance.
	 */
	public load = (manager: Manager): void => {
		this.manager = manager;
		this.log('Loading MagmaConnect plugin');
		this.refreshAllNodeLocations().catch((err) => this.log('Node geo refresh error: ' + (err as Error).message));

		if (this.options.refreshIntervalMs && this.options.refreshIntervalMs > 0) {
			this.interval = setInterval(() => {
				this.refreshAllNodeLocations().catch((err) => this.log('Node geo refresh error: ' + (err as Error).message));
			}, this.options.refreshIntervalMs);
		}

		// Patch Manager.create to inject best nodeIdentifier if missing
		this.originalCreate = manager.create.bind(manager);
		manager.create = ((opts: PlayerOptions) => {
			const patched = { ...opts };
			if (!patched.nodeIdentifier) {
				const target = () => this.getTargetForGuild(patched.guildId);
				const id = this.pickBestNodeIdentifier(target);
				if (id) patched.nodeIdentifier = id;
			}
			return this.originalCreate!(patched);
		}) as Manager['create'];

		// Patch Manager.updateVoiceState to capture guild voice endpoint -> region mapping
		this.originalUpdateVoiceState = manager.updateVoiceState.bind(manager);
		manager.updateVoiceState = (async (data: any) => {
			try {
				const vs = this.extractVoiceServerUpdate(data);
				if (vs && vs.guild_id && vs.endpoint) {
					const region = this.parseDiscordRegionFromEndpoint(vs.endpoint);
					const latlon = region ? this.regionToLatLon(region) : undefined;
					if (latlon) {
						this.guildGeo.set(vs.guild_id, latlon);
						this.log(`Cached guild ${vs.guild_id} region ${region} => ${latlon.lat.toFixed(2)},${latlon.lon.toFixed(2)}`);
					}
				}
			} catch {
				// ignore
			}
			return this.originalUpdateVoiceState!(data);
		}) as Manager['updateVoiceState'];

		this.log('MagmaConnect plugin loaded');
	};

	/**
	 * Unloads the plugin: clears timers and restores patched Manager methods.
	 */
	public unload = (_: Manager): void => {
		this.log('Unloading MagmaConnect plugin');
		if (this.interval) clearInterval(this.interval);
		if (this.manager && this.originalCreate) this.manager.create = this.originalCreate;
		if (this.manager && this.originalUpdateVoiceState) this.manager.updateVoiceState = this.originalUpdateVoiceState;
		this.log('MagmaConnect plugin unloaded');
	};

	/**
	 * Chooses the closest node by great-circle distance to the provided target location.
	 * Falls back to bot host location, then the first available node.
	 * @param getTarget Function returning target Lat/Lon or a promise to it.
	 * @returns The chosen node identifier/host or undefined if no nodes are present.
	 */
	private pickBestNodeIdentifier = (getTarget: () => Promise<LatLon | undefined> | LatLon | undefined): string | undefined => {
		const m = this.manager;
		if (!m || m.nodes.size === 0) return undefined;

		const nodes = [...m.nodes.values()];
		const target = this.resolveSyncOrAsync(getTarget());
		const loc = target ?? this.getSelfLocationCached();
		if (!loc) return nodes[0]?.options.identifier ?? nodes[0]?.options.host; // fallback

		nodes.forEach((n) => {
			const id = n.options.identifier ?? n.options.host;
			if (!this.nodeGeo.has(id)) void this.resolveNodeLocation(n.options).then((ll) => ll && this.nodeGeo.set(id, ll));
		});

		let best: { id: string; dist: number } | undefined;
		for (const n of nodes) {
			const id = n.options.identifier ?? n.options.host;
			const ll = this.nodeGeo.get(id);
			if (!ll) continue;
			const d = this.haversineKm(loc, ll);
			if (!best || d < best.dist) best = { id, dist: d };
		}
		return best?.id ?? nodes[0]?.options.identifier ?? nodes[0]?.options.host;
	};

	/**
	 * Resolves and caches geolocation for all configured nodes.
	 */
	private refreshAllNodeLocations = async (): Promise<void> => {
		const m = this.manager;
		if (!m) return;
		const promises: Promise<void>[] = [];
		for (const n of m.nodes.values()) {
			const id = n.options.identifier ?? n.options.host;
			if (this.options.nodeLocations && this.options.nodeLocations[id]) {
				const ll = await this.normalizeLoc(this.options.nodeLocations[id]);
				if (ll) this.nodeGeo.set(id, ll);
				continue;
			}
			promises.push(
				this.resolveNodeLocation(n.options)
					.then((ll) => {
						if (ll) this.nodeGeo.set(id, ll);
					})
					.catch(() => void 0)
			);
		}
		await Promise.all(promises);
	};

	/**
	 * Determines the geolocation of a node using overrides or public IP geo services.
	 * @param node Node options (host/identifier).
	 */
	private resolveNodeLocation = async (node: NodeOptions): Promise<LatLon | undefined> => {
		const id = node.identifier ?? node.host;
		const override = this.options.nodeLocations?.[id];
		if (override) return this.normalizeLoc(override);
		const byHost = await this.geoByHost(node.host).catch(() => undefined);
		if (byHost) return byHost;
		return undefined;
	};

	/**
	 * Queries free public APIs to geolocate an IP/hostname.
	 * @param host Node host/IP.
	 */
	private geoByHost = async (host: string): Promise<LatLon | undefined> => {
		const urls = [
			`https://ipwho.is/${encodeURIComponent(host)}?fields=success,latitude,longitude`,
			`http://ip-api.com/json/${encodeURIComponent(host)}?fields=status,lat,lon`,
		];
		for (const url of urls) {
			const data = await this.fetchJson(url, 4500).catch(() => undefined);
			if (!data) continue;
			if ('success' in data && data.success && typeof data.latitude === 'number' && typeof data.longitude === 'number')
				return { lat: data.latitude, lon: data.longitude };
			if ('status' in data && data.status === 'success' && typeof data.lat === 'number' && typeof data.lon === 'number') return { lat: data.lat, lon: data.lon };
		}
		return undefined;
	};

	/**
	 * Computes the target location for a guild: cached voice region -> lat/lon, user resolver, or bot host.
	 * @param guildId Guild ID.
	 */
	private getTargetForGuild = async (guildId: string): Promise<LatLon | undefined> => {
		const cached = this.guildGeo.get(guildId);
		if (cached) return cached;
		if (this.options.getGuildLocation) {
			const v = await this.options.getGuildLocation(guildId);
			if (v) return this.normalizeLoc(v);
		}
		return this.getSelfLocationCached();
	};

	/**
	 * Returns cached bot host geolocation; kicks off async fetch on first call.
	 */
	private getSelfLocationCached = (): LatLon | undefined => {
		if (this.selfGeo) return this.selfGeo;
		void this.getSelfLocation()
			.then((ll) => (this.selfGeo = ll))
			.catch(() => void 0);
		return this.selfGeo;
	};

	/**
	 * Fetches bot host geolocation using public APIs.
	 */
	private getSelfLocation = async (): Promise<LatLon | undefined> => {
		const data = await this.fetchJson('https://ipwho.is/?fields=success,latitude,longitude', 4500).catch(() => undefined);
		if (data && data.success && typeof data.latitude === 'number' && typeof data.longitude === 'number') return { lat: data.latitude, lon: data.longitude };
		const data2 = await this.fetchJson('http://ip-api.com/json/?fields=status,lat,lon', 4500).catch(() => undefined);
		if (data2 && data2.status === 'success' && typeof data2.lat === 'number' && typeof data2.lon === 'number') return { lat: data2.lat, lon: data2.lon };
		return undefined;
	};

	/**
	 * Great-circle distance between two coordinates using the Haversine formula.
	 * @param a Point A
	 * @param b Point B
	 * @returns Distance in kilometers
	 */
	private haversineKm = (a: LatLon, b: LatLon): number => {
		const toRad = (x: number) => (x * Math.PI) / 180;
		const R = 6371; // km
		const dLat = toRad(b.lat - a.lat);
		const dLon = toRad(b.lon - a.lon);
		const lat1 = toRad(a.lat);
		const lat2 = toRad(b.lat);
		const sinDLat = Math.sin(dLat / 2);
		const sinDLon = Math.sin(dLon / 2);
		const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
		return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
	};

	/**
	 * Normalizes either a coordinate or a region code to a coordinate.
	 * @param v Coordinate or region wrapper.
	 */
	private normalizeLoc = async (v: LatLon | { region: string }): Promise<LatLon | undefined> => {
		if ('lat' in v) return v;
		const ll = this.regionToLatLon(v.region);
		return ll;
	};

	/**
	 * Extracts a Voice Server Update shape from multiple possible payloads.
	 */
	private extractVoiceServerUpdate = (data: any): { guild_id: string; endpoint: string } | undefined => {
		if (data && typeof data === 'object') {
			if (data.t === 'VOICE_SERVER_UPDATE' && data.d && typeof data.d.endpoint === 'string') return { guild_id: data.d.guild_id, endpoint: data.d.endpoint };
			if (typeof data.endpoint === 'string' && typeof data.guild_id === 'string') return { guild_id: data.guild_id, endpoint: data.endpoint };
			if (data.event && typeof data.event.endpoint === 'string' && typeof data.event.guild_id === 'string')
				return { guild_id: data.event.guild_id, endpoint: data.event.endpoint };
		}
		return undefined;
	};

	/**
	 * Parses a Discord media endpoint hostname into a region label.
	 * @param endpoint e.g., "us-east123.discord.media:443"
	 */
	private parseDiscordRegionFromEndpoint = (endpoint: string): string | undefined => {
		const host = endpoint.split(':')[0];
		const parts = host.split('.');
		if (parts.length < 3) return undefined;
		const first = parts[0];
		const region = first.replace(/\d+$/, '');
		return region || undefined;
	};

	/**
	 * Maps common region names to approximate lat/lon coordinates.
	 */
	private regionToLatLon = (region: string): LatLon | undefined => {
		const key = region.toLowerCase();
		const map: Record<string, LatLon> = {
			'us-east': { lat: 39.0, lon: -77.0 },
			'us-west': { lat: 37.4, lon: -122.0 },
			'us-central': { lat: 41.6, lon: -93.6 },
			'us-south': { lat: 29.4, lon: -98.5 },
			brazil: { lat: -23.5, lon: -46.6 },
			singapore: { lat: 1.29, lon: 103.85 },
			hongkong: { lat: 22.32, lon: 114.17 },
			'hong-kong': { lat: 22.32, lon: 114.17 },
			russia: { lat: 55.75, lon: 37.62 },
			europe: { lat: 50.11, lon: 8.68 },
			'eu-central': { lat: 50.11, lon: 8.68 },
			'eu-west': { lat: 48.86, lon: 2.35 },
			sydney: { lat: -33.86, lon: 151.21 },
			japan: { lat: 35.68, lon: 139.69 },
			india: { lat: 19.08, lon: 72.88 },
			southafrica: { lat: -26.2, lon: 28.04 },
			'south-africa': { lat: -26.2, lon: 28.04 },
			dubai: { lat: 25.2, lon: 55.27 },
			frankfurt: { lat: 50.11, lon: 8.68 },
			london: { lat: 51.51, lon: -0.13 },
			amsterdam: { lat: 52.37, lon: 4.9 },
			mumbai: { lat: 19.08, lon: 72.88 },
			chicago: { lat: 41.88, lon: -87.62 },
			atlanta: { lat: 33.75, lon: -84.39 },
			dallas: { lat: 32.78, lon: -96.8 },
			miami: { lat: 25.77, lon: -80.19 },
			newyork: { lat: 40.71, lon: -74.01 },
			'new-york': { lat: 40.71, lon: -74.01 },
			paris: { lat: 48.86, lon: 2.35 },
			stockholm: { lat: 59.33, lon: 18.06 },
			seoul: { lat: 37.57, lon: 126.98 },
			toronto: { lat: 43.65, lon: -79.38 },
			montreal: { lat: 45.5, lon: -73.57 },
		};
		return map[key];
	};

	/**
	 * Lightweight JSON GET using Node's http/https modules.
	 * @param url Resource URL
	 * @param timeoutMs Request timeout in milliseconds
	 */
	private fetchJson = async (url: string, timeoutMs = 5000): Promise<any> => {
		return new Promise((resolve, reject) => {
			const u = new URL(url);
			const isHttp = u.protocol === 'http:';
			const mod = isHttp ? require('http') : require('https');
			const req = mod.request(u, { method: 'GET', timeout: timeoutMs, headers: { 'user-agent': 'magma-connect/0.1' } }, (res: any) => {
				const statusCode = res.statusCode ?? 0;
				if (statusCode >= 400) {
					res.resume();
					reject(new Error(`HTTP ${statusCode}`));
					return;
				}
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer) => chunks.push(c));
				res.on('end', () => {
					try {
						const body = Buffer.concat(chunks).toString('utf8');
						resolve(body ? JSON.parse(body) : {});
					} catch (e) {
						reject(e);
					}
				});
			});
			req.on('error', reject);
			req.on('timeout', () => req.destroy(new Error('Request timeout')));
			req.end();
		});
	};

	/**
	 * If a promise-like is passed, returns undefined to avoid blocking a sync path.
	 * Otherwise returns the value directly.
	 */
	private resolveSyncOrAsync = <T>(v: T | Promise<T> | undefined): T | undefined => {
		if (v && typeof (v as any).then === 'function') return undefined;
		return v as T | undefined;
	};

	/**
	 * Debug logger for the plugin.
	 *
	 * Prefixed with [MagmaConnect] and only emits output when `options.debug` is true.
	 * Use this for internal diagnostics; production users can disable by leaving `debug` unset/false.
	 *
	 * @param msg The message to print when debug logging is enabled.
	 */
	private log = (msg: string): void => {
		if (this.options.debug) console.log(`[MagmaConnect] ${msg}`);
	};
}
