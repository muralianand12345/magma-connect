import { Plugin, Manager } from 'magmastream';
export type LatLon = {
    lat: number;
    lon: number;
};
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
    nodeLocations?: Record<string, LatLon | {
        region: string;
    }>;
    getGuildLocation?: (guildId: string) => Promise<LatLon | {
        region: string;
    } | undefined>;
    refreshIntervalMs?: number;
    debug?: boolean;
}
export declare class MagmaConnect extends Plugin {
    private readonly options;
    private manager?;
    private interval?;
    private originalCreate?;
    private originalUpdateVoiceState?;
    private nodeGeo;
    private guildGeo;
    private selfGeo?;
    private selfGeoPromise?;
    private isLoaded;
    constructor(options?: MagmaConnectOptions);
    load: (manager: Manager) => void;
    unload: (_: Manager) => void;
    private pickBestNodeIdentifier;
    private refreshAllNodeLocations;
    private resolveNodeLocation;
    private geoByHost;
    private getTargetForGuild;
    private getTargetForGuildSync;
    private getSelfLocation;
    private haversineKm;
    private normalizeLoc;
    private extractVoiceServerUpdate;
    private parseDiscordRegionFromEndpoint;
    private regionToLatLon;
    private fetchJson;
    private log;
}
