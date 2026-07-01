#!/usr/bin/env node
//#region src/hello.ts
function hello() {
	return "Hello, world!";
}
//#endregion
//#region src/index.ts
const message = hello();
console.log(message);
//#endregion
export {};
