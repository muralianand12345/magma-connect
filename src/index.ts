import { Manager } from 'magmastream';
import { MagmaConnect, MyOptions } from './plugin';

const options: MyOptions = { test: 'hello' };
const plugin = new MagmaConnect(options);

const manager = new Manager({
	enabledPlugins: [plugin],
});

plugin.load(manager);
plugin.unload(manager);

export = MagmaConnect;
