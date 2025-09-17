import { Plugin, Manager } from 'magmastream';

export class MagmaConnect extends Plugin {
	private readonly options: MyOptions;
	public constructor(options: MyOptions) {
		super('ExamplePlugin');
		this.options = options;
	}

	public load(_: Manager): void {
		console.log('ExamplePlugin loaded with options:', this.options);
	}

	public unload(_: Manager): void {
		console.log('ExamplePlugin unloaded');
	}
}

export interface MyOptions {
	test?: string;
}
