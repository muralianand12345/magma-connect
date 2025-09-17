import { Plugin } from 'magmastream';

export class MagmaConnect extends Plugin {
	private readonly options: MyOptions;
	public constructor(options: MyOptions) {
		super("ExamplePlugin");
		this.options = options;
	}

	public load(manager: import("magmastream").Manager): void {
		console.log("ExamplePlugin loaded with options:", this.options);
	}

	public unload(manager: import("magmastream").Manager): void {
		console.log("ExamplePlugin unloaded");
	}
}

export interface MyOptions {
	test?: string;
}
