/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Command line helper shipped alongside Firefox for working with Windows push
//! notifications. This is currently plumbing only and can be invoked from a console,
//! but implements no commands yet.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::Parser;

const PROGRAM: &str = env!("CARGO_BIN_NAME");

/// File that every Firefox profile directory carries, used to tell a profile
/// apart from an arbitrary directory.
const PROFILE_MARKER: &str = "compatibility.ini";

#[derive(Parser)]
#[command(name = PROGRAM, about, disable_version_flag = true)]
struct Args {
    /// Firefox profile directory this helper serves.
    #[arg(long, value_name = "PATH")]
    profile: PathBuf,
}

/// Verifies if <path> is a real profile directory. Note: it is fairly easy to
/// bypass this check, so this only exists as a spot check for calls to this helper.
/// Do not treat this as a guarantee that the profile is real.
fn check_profile(path: &Path) -> Result<(), String> {
    match path.metadata() {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(format!("not a directory: {}", path.display())),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(format!("no such directory: {}", path.display()));
        }
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    }

    if !path.join(PROFILE_MARKER).is_file() {
        return Err(format!("not a Firefox profile: {}", path.display()));
    }

    Ok(())
}

fn main() -> ExitCode {
    let args = Args::parse();

    if let Err(message) = check_profile(&args.profile) {
        eprintln!("{PROGRAM}: {message}");
        return ExitCode::FAILURE;
    }

    println!("Starting to fetch notifications 🦀 🦊");
    println!("profile: {}", args.profile.display());

    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::ffi::OsStr;

    use clap::CommandFactory;

    /// clap's own check for a malformed derive: duplicate names, unreachable
    /// arguments, and the like. Cheap, and it fails at build time rather than
    /// on the first user who passes the wrong flag.
    #[test]
    fn the_argument_definition_is_well_formed() {
        Args::command().debug_assert();
    }

    /// clap has no opinion on whether a path exists, so a bogus `--profile`
    /// parses cleanly and is only rejected once `check_profile` looks at it.
    #[test]
    fn a_profile_that_does_not_exist_is_rejected() {
        let path = std::env::temp_dir().join(format!("{PROGRAM}-missing-{}", std::process::id()));
        let args = Args::try_parse_from([
            OsStr::new(PROGRAM),
            OsStr::new("--profile"),
            path.as_os_str(),
        ])
        .unwrap();

        let error = check_profile(&args.profile).unwrap_err();

        assert!(error.starts_with("no such directory:"), "{error}");
    }
}
