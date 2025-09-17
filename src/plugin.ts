import { Plugin } from "magmastream";

// .. Functions for the plugin example add a check function to make sure everything for the plugin is passed
// .. when a user want to use the plugin, etc...

export class ExamplePlugin extends Plugin {
	private readonly options: MyOptions;
	// .. Varibles defined here as either public or private.
	// private myVar: string;

	public constructor(options: MyOptions) {
		super();
		// .. If you have a check function call it here. ex: 'check()'
		this.options = options; // .. edit to your code needs.
		// ... rest of your code.
	}
}

// .. Interfaces, types, etc... are defined here.

export interface MyOptions {
	test?: string;
}
