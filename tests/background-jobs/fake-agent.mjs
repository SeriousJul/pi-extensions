// A stand-in for an agent process: a bare node process that starts one real
// job through the background-jobs core, then idles. The lifetime tests
// spawn it, wait for the job to start, and kill the process. As the parent
// of the job's wrapper it stands in exactly for a live pi process.
//
// Requires Node 23.6 or newer: the core is TypeScript and the node runtime
// strips its types natively. The test names this file and the core by
// absolute paths, passed in JOBS_ROOT, JOB_CMD, JOB_CWD, and CORE_PATH.
const { startJob } = await import(process.env.CORE_PATH);
const res = startJob({
	jobsRoot: process.env.JOBS_ROOT,
	command: process.env.JOB_CMD,
	cwd: process.env.JOB_CWD,
});
if (!res.ok) {
	console.error(`start failed: ${res.error}`);
	process.exit(1);
}
console.log(`JOB ${res.manifest.jobId} pid=${res.manifest.pid}`);
setInterval(() => {}, 1000);
