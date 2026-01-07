import http from 'http';
import https from 'https';
import { Plugin, Manager, NodeOptions, PlayerOptions } from 'magmastream';
import type { VoicePacket, VoiceServer, VoiceState } from 'magmastream';

export type LatLon = { lat: number; lon: number };

export interface VoiceServerUpdate {
	guild_id: string;
	endpoint: string;
}

export interface IpWhoResponse {
	success: boolean;
	latitude?: number;
	longitude?: number;
}

export interface IpApiResponse {
	status: string;
	lat?: number;
	lon?: number;
}

export type GeoApiResponse = IpWhoResponse | IpApiResponse;

export interface MagmaConnectOptions {
	nodeLocations?: Record<string, LatLon | { region: string }>;
	getGuildLocation?: (guildId: string) => Promise<LatLon | { region: string } | undefined>;
	refreshIntervalMs?: number;
	debug?: boolean;
}

interface HttpResponse {
	statusCode?: number;
	on: (event: string, callback: (data?: Buffer) => void) => void;
	resume: () => void;
}

const REGION_COORDINATES: Record<string, LatLon> = {
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

export class MagmaConnect extends Plugin {
	private readonly options: MagmaConnectOptions;
	private manager?: Manager;
	private interval?: NodeJS.Timeout;
	private originalCreate?: Manager['create'];
	private originalUpdateVoiceState?: Manager['updateVoiceState'];
	private nodeGeo = new Map<string, LatLon>();
	private guildGeo = new Map<string, LatLon>();
	private selfGeo?: LatLon;
	private selfGeoPromise?: Promise<LatLon | undefined>;
	private isLoaded = false;

	public constructor(options: MagmaConnectOptions = {}) {
		super('MagmaConnect');
		this.options = options;
	}

	public load = (manager: Manager): void => {
		if (this.isLoaded) return;
		this.isLoaded = true;
		this.manager = manager;
		this.log('Loading MagmaConnect plugin');

		this.selfGeoPromise = this.getSelfLocation()
			.then((ll) => {
				this.selfGeo = ll;
				if (ll) this.log(`Self location cached => ${ll.lat.toFixed(2)},${ll.lon.toFixed(2)}`);
				return ll;
			})
			.catch((e) => {
				this.log(`Self geo fetch error: ${(e as Error).message}`);
				return undefined;
			});

		this.refreshAllNodeLocations().catch((err) => this.log('Node geo refresh error: ' + (err as Error).message));

		if (this.options.refreshIntervalMs && this.options.refreshIntervalMs > 0) {
			this.interval = setInterval(() => {
				this.refreshAllNodeLocations().catch((err) => this.log('Node geo refresh error: ' + (err as Error).message));
			}, this.options.refreshIntervalMs);
		}

		this.originalCreate = manager.create.bind(manager);
		manager.create = (opts: PlayerOptions) => {
			try {
				const patched = { ...opts };
				if (!patched.nodeIdentifier) {
					const target = this.getTargetForGuildSync(patched.guildId);
					const id = this.pickBestNodeIdentifier(target);
					if (id) {
						patched.nodeIdentifier = id;
						this.log(`Selected node ${id} for guild ${patched.guildId}`);
					}
					this.getTargetForGuild(patched.guildId).catch(() => undefined);
				}
				return this.originalCreate!(patched);
			} catch (error) {
				this.log(`Error in patched create: ${(error as Error).message}`);
				return this.originalCreate!(opts);
			}
		};

		this.originalUpdateVoiceState = manager.updateVoiceState.bind(manager);
		manager.updateVoiceState = (data: VoicePacket | VoiceServer | VoiceState) => {
			try {
				const vs = this.extractVoiceServerUpdate(data);
				if (vs?.guild_id && vs?.endpoint) {
					const region = this.parseDiscordRegionFromEndpoint(vs.endpoint);
					const latlon = region ? this.regionToLatLon(region) : undefined;
					if (latlon) {
						this.guildGeo.set(vs.guild_id, latlon);
						this.log(`Cached guild ${vs.guild_id} region ${region} => ${latlon.lat.toFixed(2)},${latlon.lon.toFixed(2)}`);
					}
				}
			} catch {
				// ignore extraction errors
			}
			return this.originalUpdateVoiceState!(data);
		};

		this.log('MagmaConnect plugin loaded');
	};

	public unload = (_: Manager): void => {
		this.log('Unloading MagmaConnect plugin');
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
		if (this.manager && this.originalCreate) {
			this.manager.create = this.originalCreate;
		}
		if (this.manager && this.originalUpdateVoiceState) {
			this.manager.updateVoiceState = this.originalUpdateVoiceState;
		}
		this.isLoaded = false;
		this.log('MagmaConnect plugin unloaded');
	};

	private pickBestNodeIdentifier = (target?: LatLon): string | undefined => {
		const m = this.manager;
		if (!m || m.nodes.size === 0) return undefined;

		const nodes = [...m.nodes.values()].filter((n) => n.connected);
		if (nodes.length === 0) return undefined;

		const loc = target ?? this.selfGeo;

		if (!loc) {
			const firstNode = nodes[0];
			return firstNode?.options.identifier ?? firstNode?.options.host;
		}

		for (const n of nodes) {
			const id = n.options.identifier ?? n.options.host;
			if (!this.nodeGeo.has(id)) {
				this.resolveNodeLocation(n.options)
					.then((ll) => ll && this.nodeGeo.set(id, ll))
					.catch(() => undefined);
			}
		}

		let best: { id: string; dist: number } | undefined;
		for (const n of nodes) {
			const id = n.options.identifier ?? n.options.host;
			const ll = this.nodeGeo.get(id);
			if (!ll) continue;
			const d = this.haversineKm(loc, ll);
			if (!best || d < best.dist) {
				best = { id, dist: d };
			}
		}

		if (best) {
			this.log(`Best node: ${best.id} (${best.dist.toFixed(0)}km from target)`);
			return best.id;
		}

		const fallbackNode = nodes[0];
		return fallbackNode?.options.identifier ?? fallbackNode?.options.host;
	};

	private refreshAllNodeLocations = async (): Promise<void> => {
		const m = this.manager;
		if (!m) return;

		const promises: Promise<void>[] = [];

		for (const n of m.nodes.values()) {
			const id = n.options.identifier ?? n.options.host;

			if (this.options.nodeLocations?.[id]) {
				const override = this.options.nodeLocations[id];
				promises.push(
					this.normalizeLoc(override)
						.then((ll) => {
							if (ll) {
								this.nodeGeo.set(id, ll);
								this.log(`Node ${id} location set from override => ${ll.lat.toFixed(2)},${ll.lon.toFixed(2)}`);
							}
						})
						.catch(() => undefined)
				);
				continue;
			}

			promises.push(
				this.resolveNodeLocation(n.options)
					.then((ll) => {
						if (ll) {
							this.nodeGeo.set(id, ll);
							this.log(`Node ${id} resolved via host lookup => ${ll.lat.toFixed(2)},${ll.lon.toFixed(2)}`);
						}
					})
					.catch((e) => this.log(`Node ${id} location resolution error: ${(e as Error).message}`))
			);
		}

		await Promise.allSettled(promises);
	};

	private resolveNodeLocation = async (node: NodeOptions): Promise<LatLon | undefined> => {
		const id = node.identifier ?? node.host;
		const override = this.options.nodeLocations?.[id];
		if (override) return this.normalizeLoc(override);
		return this.geoByHost(node.host);
	};

	private geoByHost = async (host: string): Promise<LatLon | undefined> => {
		const urls = [`https://ipwho.is/${encodeURIComponent(host)}?fields=success,latitude,longitude`, `https://ipapi.co/${encodeURIComponent(host)}/json/`];

		for (const url of urls) {
			try {
				this.log(`Fetching geo for ${host} via ${url}`);
				const data = await this.fetchJson<GeoApiResponse>(url, 5000);

				if ('success' in data && data.success && typeof data.latitude === 'number' && typeof data.longitude === 'number') {
					return { lat: data.latitude, lon: data.longitude };
				}

				if ('status' in data && data.status === 'success' && typeof data.lat === 'number' && typeof data.lon === 'number') {
					return { lat: data.lat, lon: data.lon };
				}
			} catch (e) {
				this.log(`Geo fetch error for ${host}: ${(e as Error).message}`);
			}
		}

		return undefined;
	};

	private getTargetForGuild = async (guildId: string): Promise<LatLon | undefined> => {
		const cached = this.guildGeo.get(guildId);
		if (cached) return cached;

		if (this.options.getGuildLocation) {
			try {
				const v = await this.options.getGuildLocation(guildId);
				if (v) {
					const ll = await this.normalizeLoc(v);
					if (ll) {
						this.guildGeo.set(guildId, ll);
						return ll;
					}
				}
			} catch {
				// ignore resolver errors
			}
		}

		if (this.selfGeoPromise) {
			const selfLoc = await this.selfGeoPromise;
			if (selfLoc) return selfLoc;
		}

		return this.selfGeo;
	};

	private getTargetForGuildSync = (guildId: string): LatLon | undefined => {
		return this.guildGeo.get(guildId) ?? this.selfGeo;
	};

	private getSelfLocation = async (): Promise<LatLon | undefined> => {
		const urls = ['https://ipwho.is/?fields=success,latitude,longitude', 'https://ipapi.co/json/'];

		for (const url of urls) {
			try {
				this.log(`Fetching self geo from ${url}`);
				const data = await this.fetchJson<GeoApiResponse>(url, 5000);

				if ('success' in data && data.success && typeof data.latitude === 'number' && typeof data.longitude === 'number') {
					return { lat: data.latitude, lon: data.longitude };
				}

				if ('status' in data && data.status === 'success' && typeof data.lat === 'number' && typeof data.lon === 'number') {
					return { lat: data.lat, lon: data.lon };
				}
			} catch (e) {
				this.log(`Self geo fetch error: ${(e as Error).message}`);
			}
		}

		return undefined;
	};

	private haversineKm = (a: LatLon, b: LatLon): number => {
		const toRad = (x: number) => (x * Math.PI) / 180;
		const R = 6371;
		const dLat = toRad(b.lat - a.lat);
		const dLon = toRad(b.lon - a.lon);
		const lat1 = toRad(a.lat);
		const lat2 = toRad(b.lat);
		const sinDLat = Math.sin(dLat / 2);
		const sinDLon = Math.sin(dLon / 2);
		const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
		return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
	};

	private normalizeLoc = async (v: LatLon | { region: string }): Promise<LatLon | undefined> => {
		if ('lat' in v && 'lon' in v) return v;
		if ('region' in v) return this.regionToLatLon(v.region);
		return undefined;
	};

	private extractVoiceServerUpdate = (data: unknown): VoiceServerUpdate | undefined => {
		if (!data || typeof data !== 'object') return undefined;

		const anyData = data as Record<string, unknown>;

		if (anyData.t === 'VOICE_SERVER_UPDATE' && anyData.d && typeof anyData.d === 'object') {
			const d = anyData.d as Record<string, unknown>;
			if (typeof d.endpoint === 'string' && typeof d.guild_id === 'string') {
				return { guild_id: d.guild_id, endpoint: d.endpoint };
			}
		}

		if (typeof anyData.endpoint === 'string' && typeof anyData.guild_id === 'string') {
			return { guild_id: anyData.guild_id, endpoint: anyData.endpoint };
		}

		if (anyData.event && typeof anyData.event === 'object') {
			const event = anyData.event as Record<string, unknown>;
			if (typeof event.endpoint === 'string' && typeof event.guild_id === 'string') {
				return { guild_id: event.guild_id, endpoint: event.endpoint };
			}
		}

		return undefined;
	};

	private parseDiscordRegionFromEndpoint = (endpoint: string): string | undefined => {
		const host = endpoint.split(':')[0];
		const parts = host.split('.');
		if (parts.length < 1) return undefined;
		const first = parts[0];
		const region = first.replace(/\d+$/, '');
		return region || undefined;
	};

	private regionToLatLon = (region: string): LatLon | undefined => {
		return REGION_COORDINATES[region.toLowerCase()];
	};

	private fetchJson = async <T = unknown>(url: string, timeoutMs = 5000): Promise<T> => {
		return new Promise<T>((resolve, reject) => {
			const u = new URL(url);
			const isHttps = u.protocol === 'https:';
			const mod = isHttps ? https : http;

			const req = mod.request(
				u,
				{
					method: 'GET',
					timeout: timeoutMs,
					headers: { 'User-Agent': 'MagmaConnect/1.0' },
				},
				(res: HttpResponse) => {
					const statusCode = res.statusCode ?? 0;
					if (statusCode >= 400) {
						res.resume();
						reject(new Error(`HTTP ${statusCode}`));
						return;
					}

					const chunks: Buffer[] = [];
					res.on('data', (c?: Buffer) => {
						if (c) chunks.push(c);
					});
					res.on('end', () => {
						try {
							const body = Buffer.concat(chunks).toString('utf8');
							resolve(body ? (JSON.parse(body) as T) : ({} as T));
						} catch (e) {
							reject(e);
						}
					});
				}
			);

			req.on('error', reject);
			req.on('timeout', () => {
				req.destroy();
				reject(new Error('Request timeout'));
			});
			req.end();
		});
	};

	private log = (msg: string): void => {
		if (this.options.debug) console.log(`[MAGMACONNECT] ${msg}`);
	};
}
