# magma-connect

A MagmaStream plugin that picks the best Lavalink node for each guild based on region and geolocation. It acts like a lightweight load balancer that prefers the node closest to the guild's Discord voice region (or your bot's host as a fallback).

## Install

```bash
npm install magma-connect
# or
npm install muralianand12345/magma-connect#main
```

## Usage

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

// When you create a player without nodeIdentifier, the plugin chooses the nearest node automatically
const player = manager.create({
  guildId: '123',
  textChannelId: '456',
  voiceChannelId: '789',
});
```

## Options

- nodeLocations: `Record<string, { lat: number; lon: number } | { region: string }>`
  - Optional static positions for your nodes keyed by node identifier (or host). If provided, the plugin won't call geo APIs for those nodes.
- getGuildLocation: (guildId) => Promise<{ lat: number; lon: number } | { region: string } | undefined>
  - Optional resolver to specify a guild's approximate location.
- refreshIntervalMs: number
  - If set, periodically refreshes node geolocation.
- debug: boolean
  - Enables debug logging.

## How it works

- Learns the guild voice endpoint region from Discord VOICE_SERVER_UPDATE events and maps well-known regions to lat/long.
- Geolocates nodes via public IP geolocation services (ipwho.is, ip-api.com) using their free endpoints.
- Picks the node with the smallest great-circle distance to the guild region. Falls back to bot host location, then first available node.

## Notes

- You can override any node or guild region mapping for full control.
- The plugin does not modify existing players; it influences selection when manager.create is called without a nodeIdentifier.

## License

Apache-2.0
