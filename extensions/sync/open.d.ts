// The optional `open` package (auto-open the device flow URL). The dynamic
// import degrades to a no-op when it is not installed or no browser exists.
declare module "open" {
	const open: (url: string, options?: { app?: string }) => Promise<string | void>;
	export default open;
}
