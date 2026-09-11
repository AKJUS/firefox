/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! The two named Windows objects that govern a helper's lifetime.
//!
//! [`StopEvent`] is a manual-reset event named after a profile and an
//! installation. A helper serves exactly one profile, so signalling the event
//! asks that profile's helper, and only it, to exit. Manual reset means a
//! signal landing before the helper reaches its wait is still seen.
//!
//! [`ProfileGuard`] is a mutex named after the same profile. Only the first
//! helper to serve a profile takes it.
//!
//! Note: currently, the helpers are not revived on system restarts. Firefox needs to
//! readd these helpers on first launch for the system login session.

use std::ffi::OsStr;
use std::hash::Hasher;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use fnv::FnvHasher;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, WAIT_OBJECT_0,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateMutexW, OpenEventW, SetEvent, WaitForSingleObject, EVENT_MODIFY_STATE,
    INFINITE,
};

/// `Local\` scopes this to the caller's logon session. The prefix is case sensitive.
/// https://learn.microsoft.com/en-us/windows/win32/termserv/kernel-object-namespaces
const PREFIX: &str = "Local\\MozillaNotificationHelper";

struct OwnedHandle(HANDLE);

// SAFETY: Win32 handles belong to the process rather than to a thread, so any
// of them can use and close one. OwnedHandle owns its handle, so nothing else
// closes it out from under that thread.
//
// This moves the handle, not the kernel object's ownership: a mutex stays owned
// by the thread that acquired it, wherever its handle ends up.
unsafe impl Send for OwnedHandle {}

impl OwnedHandle {
    /// `None` for a null handle, so a failed Win32 call cannot produce one.
    fn new(handle: HANDLE) -> Option<Self> {
        (!handle.is_null()).then_some(OwnedHandle(handle))
    }

    fn get(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: OwnedHandle::new rejects a null handle, so self.0 is one that
        // CreateEventW, OpenEventW or CreateMutexW returned and that nothing
        // has closed yet. drop runs once, so it is closed exactly once.
        unsafe { CloseHandle(self.0) };
    }
}

/// Ensures that there is only one helper for each profile.
///
/// The mutex is never released explicitly: a helper holds it until the process
/// ends, and Windows drops an abandoned mutex when its last handle closes.
pub struct ProfileGuard {
    _handle: OwnedHandle,
}

impl ProfileGuard {
    /// Returns `None` when a helper is already serving `profile`, including one
    /// left running by an earlier Firefox session.
    /// https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createmutexw
    pub fn acquire(profile: &Path) -> Result<Option<Self>, String> {
        let name = wide(&object_name("profile", profile)?);

        // SAFETY: A null security descriptor asks for the default one, and
        // `name` is NUL terminated by `wide` and outlives the call.
        let handle = unsafe { CreateMutexW(std::ptr::null(), 1, name.as_ptr()) };
        let handle = OwnedHandle::new(handle)
            .ok_or_else(|| format!("CreateMutexW failed: {}", last_error()))?;

        if last_error() == ERROR_ALREADY_EXISTS {
            // Dropping `handle` closes it, leaving the mutex to its owner.
            return Ok(None);
        }

        Ok(Some(ProfileGuard { _handle: handle }))
    }
}

/// The shutdown channel for one profile's helper.
pub struct StopEvent {
    handle: OwnedHandle,
}

impl StopEvent {
    /// Opens the profile's stop event, creating it if it does not exist.
    /// https://learn.microsoft.com/en-us/windows/win32/sync/event-objects
    pub fn open(profile: &Path) -> Result<Self, String> {
        let name = wide(&object_name("stop", profile)?);

        // SAFETY: A null security descriptor asks for the default one, and
        // `name` is NUL terminated by `wide` and outlives the call.
        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, name.as_ptr()) };
        let handle = OwnedHandle::new(handle)
            .ok_or_else(|| format!("CreateEventW failed: {}", last_error()))?;

        Ok(StopEvent { handle })
    }

    /// Blocks until some process calls [`signal`] for the same profile.
    pub fn wait(&self) -> Result<(), String> {
        // SAFETY: `self` owns the event handle, so it is still open for the
        // wait; only dropping `self` closes it.
        match unsafe { WaitForSingleObject(self.handle.get(), INFINITE) } {
            WAIT_OBJECT_0 => Ok(()),
            other => Err(format!("WaitForSingleObject returned {other}")),
        }
    }
}

/// Asks the helper serving `profile` to exit. Succeeds when none is running, so
/// callers may stop unconditionally without checking first.
pub fn signal(profile: &Path) -> Result<(), String> {
    let name = wide(&object_name("stop", profile)?);

    // SAFETY: `name` is NUL terminated by `wide` and outlives the call.
    let handle = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };

    // No such event means no helper is running for this profile.
    let Some(handle) = OwnedHandle::new(handle) else {
        return Ok(());
    };

    // SAFETY: `handle` is still open, nothing having closed it since
    // OpenEventW, and that call requested the EVENT_MODIFY_STATE right that
    // SetEvent requires.
    if unsafe { SetEvent(handle.get()) } == 0 {
        return Err(format!("SetEvent failed: {}", last_error()));
    }

    Ok(())
}

/// Objects are keyed by the install directory as well as the profile.
///
/// `kind` separates the object types.
fn object_name(kind: &str, profile: &Path) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate this binary: {e}"))?;
    let install = exe
        .parent()
        .ok_or_else(|| "this binary has no parent directory".to_string())?;

    let mut hasher = FnvHasher::default();
    hasher.write(path_key(install).as_bytes());
    // A path cannot contain a NUL, so the halves cannot run into each other and
    // make two different pairs hash alike.
    hasher.write(&[0]);
    hasher.write(path_key(profile).as_bytes());

    Ok(format!("{PREFIX}-{kind}-{:016x}", hasher.finish()))
}

/// A stable key for `path`, folding the spellings Windows treats as one
/// directory: case, 8.3 short names, symlinks.
///
/// Canonicalizing does the folding but needs the path to exist. An unresolvable
/// path is therefore not an error; it keys off its literal spelling instead,
/// lowercased to approximate the case folding it missed.
fn path_key(path: &Path) -> String {
    match path.canonicalize() {
        Ok(canonical) => canonical.to_string_lossy().into_owned(),
        Err(_) => path.to_string_lossy().to_lowercase(),
    }
}

fn last_error() -> u32 {
    // SAFETY: GetLastError has no preconditions; it reads the calling thread's
    // last-error code.
    unsafe { GetLastError() }
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain([0]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_ignores_path_case() {
        assert_eq!(
            object_name("stop", Path::new(r"c:\profiles\someone")).unwrap(),
            object_name("stop", Path::new(r"C:\Profiles\SomeOne")).unwrap()
        );
    }

    #[test]
    fn distinct_profiles_get_distinct_names() {
        assert_ne!(
            object_name("stop", Path::new(r"c:\profiles\a")).unwrap(),
            object_name("stop", Path::new(r"c:\profiles\b")).unwrap()
        );
    }

    /// A mutex and an event sharing a name would collide in the one namespace,
    /// so the kind has to reach the hash.
    #[test]
    fn a_guard_never_collides_with_a_stop_event() {
        let profile = Path::new(r"c:\profiles\kinds");

        assert_ne!(
            object_name("profile", profile).unwrap(),
            object_name("stop", profile).unwrap()
        );
    }

    #[test]
    fn signal_wakes_a_waiting_helper() {
        let profile = Path::new(r"c:\profiles\signal-wakes");
        let event = StopEvent::open(profile).unwrap();

        let waiter = std::thread::spawn(move || event.wait());
        signal(profile).unwrap();

        waiter.join().unwrap().unwrap();
    }

    /// Manual reset: a signal arriving before the helper starts waiting has to
    /// still be seen, or a stop racing a startup would be lost.
    #[test]
    fn a_signal_before_the_wait_is_not_lost() {
        let profile = Path::new(r"c:\profiles\sticky-signal");
        let event = StopEvent::open(profile).unwrap();

        signal(profile).unwrap();

        event.wait().unwrap();
    }

    #[test]
    fn signal_does_not_reach_another_profile() {
        let mine = Path::new(r"c:\profiles\mine");
        let event = StopEvent::open(mine).unwrap();
        let waiter = std::thread::spawn(move || event.wait());

        signal(Path::new(r"c:\profiles\theirs")).unwrap();
        assert!(!waiter.is_finished(), "another profile's signal woke us");

        signal(mine).unwrap();
        waiter.join().unwrap().unwrap();
    }

    #[test]
    fn a_second_helper_is_refused_then_allowed_once_the_first_exits() {
        let profile = Path::new(r"c:\profiles\guard-test");

        let first = ProfileGuard::acquire(profile).unwrap();
        assert!(first.is_some(), "the first helper takes the guard");
        assert!(
            ProfileGuard::acquire(profile).unwrap().is_none(),
            "a second helper is refused while the first holds it"
        );

        drop(first);

        assert!(
            ProfileGuard::acquire(profile).unwrap().is_some(),
            "the guard is released when its owner exits"
        );
    }

    #[test]
    fn separate_profiles_do_not_block_each_other() {
        let one = ProfileGuard::acquire(Path::new(r"c:\profiles\one")).unwrap();
        let two = ProfileGuard::acquire(Path::new(r"c:\profiles\two")).unwrap();

        assert!(one.is_some() && two.is_some());
    }
}
