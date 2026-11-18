//! Linux namespace and Windows container adapters. Missing runtimes never imply sandbox success.
use std::{path::Path, process::{Command, Stdio}};
/// Probe the actual isolation runtime rather than assuming platform support.
pub fn available() -> bool {
    let mut cmd = if cfg!(target_os = "linux") {
        let mut c = Command::new("bwrap");
        c.args(["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "/bin/true"]); c
    } else if cfg!(windows) {
        let mut c = Command::new("docker"); c.args(["image", "inspect", "octopuses-runner:local"]); c
    } else { return false; };
    crate::platform::hide_console(&mut cmd);
    cmd.stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}
/// Create namespace or container arguments with workspace-only writes and optional networking.
pub fn wrap(command: &str, workspace: &Path, network: bool) -> Option<(String, Vec<String>)> {
    let path = workspace.to_string_lossy().to_string();
    if cfg!(target_os = "linux") {
        let mut args = ["--die-with-parent", "--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "--bind", &path, &path, "--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev", "--chdir", &path].map(str::to_string).to_vec();
        if !network { args.push("--unshare-net".into()); }
        args.extend(["/bin/sh".into(), "-lc".into(), command.into()]); Some(("bwrap".into(), args))
    } else if cfg!(windows) {
        if path.contains(',') { return None; }
        let mut args = ["run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "2g", "--tmpfs", "/tmp", "--mount"].map(str::to_string).to_vec();
        args.push(format!("type=bind,src={path},dst=/workspace"));
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
        args.extend(["--name".into(), format!("octopuses-command-{}-{stamp}", std::process::id())]);
        if !network { args.extend(["--network".into(), "none".into()]); }
        args.extend(["-w", "/workspace", "octopuses-runner:local", "/bin/sh", "-lc", command].map(str::to_string)); Some(("docker".into(), args))
    } else { None }
}
