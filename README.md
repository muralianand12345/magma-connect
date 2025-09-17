# magma-connect

Smart MagmaStream plugin that picks the best Lavalink node per guild using region and geolocation. It acts like a lightweight load balancer: if you don’t specify a node, it chooses the closest one to the guild’s Discord voice region (or your bot host as fallback).

## Features

- Per-guild node selection based on distance (Haversine great‑circle)
- Learns guild regions from Discord VOICE_SERVER_UPDATE events
- Optional static overrides for node and guild locations
- Background refresh of node geolocation
- Safe defaults and graceful fallbacks when data is missing

## Requirements

- Node.js >= 16
- magmastream ^2.9.0 (peer dependency)
- One or more Lavalink nodes configured in your Manager

## Install

```bash
npm install magma-connect
# or
yarn add magma-connect
# or directly from GitHub (main branch)
yarn add muralianand12345/magma-connect#main
```

## Quick start

```ts
import { Manager } from 'magmastream';
import { MagmaConnect } from 'magma-connect';

const manager = new Manager({
  nodes: [
    { host: 'lavalink-us.myhost.com', identifier: 'us', password: 'youshallnotpass' },
    { host: 'lavalink-eu.myhost.com', identifier: 'eu', password: 'youshallnotpass' },
  ],
  enabledPlugins: [
    new MagmaConnect({ debug: true, refreshIntervalMs: 60_000 }),
  ],
});

await manager.init({ clientId: 'YOUR_CLIENT_ID', clusterId: 0 });

// If you omit nodeIdentifier, the plugin auto-picks the nearest node
const player = manager.create({
  guildId: '123',
  textChannelId: '456',
  voiceChannelId: '789',
});

// You can still force a node explicitly:
// manager.create({ ..., nodeIdentifier: 'eu' })
```

## Options

```ts
export interface MagmaConnectOptions {
  /** Optional explicit node locations keyed by node identifier (or host if no identifier). */
  nodeLocations?: Record<string, { lat: number; lon: number } | { region: string }>;
  /** Optional provider to supply a guild's approximate location or region code. */
  getGuildLocation?: (guildId: string) => Promise<{ lat: number; lon: number } | { region: string } | undefined>;
  /** Interval (ms) to periodically refresh node geolocation. Disable by leaving undefined/0. */
  refreshIntervalMs?: number;
  /** Enables debug logging prefixed with [MAGMACONNECT]. */
  debug?: boolean;
}
```

### Example: static node locations

```ts
new MagmaConnect({
  nodeLocations: {
    us: { region: 'us-east' },
    eu: { lat: 50.11, lon: 8.68 }, // Frankfurt
  },
});
```

### Example: custom guild resolver

```ts
new MagmaConnect({
  getGuildLocation: async (guildId) => {
    // e.g., fetch from your DB
    const cfg = await db.guilds.find(guildId);
    return cfg?.region ? { region: cfg.region } : undefined;
  },
});
```

## How it chooses a node

1. Capture guild voice region from VOICE_SERVER_UPDATE and map to lat/lon.
2. Resolve node geolocation via:
   - Static `nodeLocations` overrides, or
   - Public IP geo APIs (ipwho.is, ip-api.com) using their free endpoints.
3. Compute great‑circle distance from guild location to each node and pick the closest.
4. Fallbacks: bot host location -> first configured node.

Notes:
- Existing players aren’t modified; selection happens when `manager.create` is called without `nodeIdentifier`.
- You can override guild and node locations at any time for full control.

## Privacy and networking

When no overrides are provided, the plugin may query public geolocation APIs:
- https://ipwho.is
- http://ip-api.com

Only hostnames/IPs of your Lavalink nodes (and your server’s public IP for fallback) are sent. Consider providing `nodeLocations` if you prefer zero external lookups or are behind NAT.

## Troubleshooting

- Always picking the same node: ensure `VOICE_SERVER_UPDATE` events reach the Manager and that your nodes have distinct identifiers/hosts.
- Corporate/VPC networks: public geo may be inaccurate. Provide `nodeLocations`.
- Frequent API timeouts: set `refreshIntervalMs` higher and/or use static locations.

## Development

```bash
# Lint and build
yarn lint
yarn build
```

Type definitions are included. The library can be used from TypeScript or JavaScript (CJS or ESM).

## License

Apache-2.0
