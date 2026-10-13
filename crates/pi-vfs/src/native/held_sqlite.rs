//! Host files a SQLite connection in this process holds POSIX locks on.
//!
//! SQLite's unix VFS locks with `fcntl` record locks, which belong to the
//! process rather than the descriptor: closing *any* descriptor on the inode
//! releases every lock the process holds on it (SQLite "How To Corrupt" §2.2).
//! A byte-level open+close of a live database or its `-shm` WAL index thus
//! silently unlocks the process's own connection; peer processes then believe
//! they are the last connection, checkpoint and unlink the WAL, and the
//! orphaned connection later writes stale pages over the live file.
//!
//! [`held_by_sqlite`] recognizes those inodes before a descriptor exists, so
//! host opens can refuse them. Windows locks are per handle, so it never
//! matches there.

use std::{io, path::Path};

/// Whether `path` is a SQLite database or WAL index this process holds open.
///
/// Only an open+close outside SQLite endangers such a file; opening it
/// through SQLite is safe because SQLite defers its own closes while locks
/// are held. Missing paths and non-regular files never match.
#[cfg(unix)]
pub fn held_by_sqlite(path: &Path) -> bool {
	use std::os::unix::fs::MetadataExt;

	let held = scan::held_inodes();
	if held.is_empty() {
		return false;
	}
	std::fs::metadata(path)
		.is_ok_and(|meta| meta.is_file() && held.contains(&(meta.dev(), meta.ino())))
}

/// Whether `path` is a SQLite database or WAL index this process holds open.
#[cfg(not(unix))]
pub fn held_by_sqlite(_path: &Path) -> bool {
	false
}

/// Refuses `path` when opening it outside SQLite would release the locks of
/// this process's own connection (see [`held_by_sqlite`]).
///
/// # Errors
/// [`io::ErrorKind::ResourceBusy`] when `path` is held.
pub(crate) fn refuse_held_sqlite(path: &Path) -> io::Result<()> {
	if !held_by_sqlite(path) {
		return Ok(());
	}
	Err(io::Error::new(
		io::ErrorKind::ResourceBusy,
		"SQLite database held open by this process; opening it outside SQLite would release the \
		 connection's locks",
	))
}

#[cfg(unix)]
mod scan {
	use std::{
		collections::HashSet,
		fs,
		mem::MaybeUninit,
		sync::Arc,
		time::{Duration, Instant},
	};

	use parking_lot::Mutex;

	/// `(dev, ino)` of every held SQLite database and WAL index.
	pub(super) type HeldInodes = Arc<HashSet<(u64, u64)>>;

	/// How long one descriptor-table scan answers lookups. Walks open
	/// thousands of files per second, and a scan costs an `fstat`+`pread` per
	/// descriptor; SQLite only gains files when a connection opens, so a
	/// connection younger than this window is the one case a lookup misses.
	const SCAN_TTL: Duration = Duration::from_millis(100);

	#[cfg(any(target_os = "linux", target_os = "android"))]
	const FD_DIR: &str = "/proc/self/fd";
	#[cfg(not(any(target_os = "linux", target_os = "android")))]
	const FD_DIR: &str = "/dev/fd";

	/// Main database header: `"SQLite format 3\0"`.
	const DB_MAGIC: &[u8; 16] = b"SQLite format 3\0";
	/// `iVersion` that opens a WAL-index (`-shm`) header, stored in native
	/// byte order.
	const WAL_INDEX_VERSION: u32 = 3_007_000;

	static LAST_SCAN: Mutex<Option<(Instant, HeldInodes)>> = Mutex::new(None);

	pub(super) fn held_inodes() -> HeldInodes {
		let mut last = LAST_SCAN.lock();
		if let Some((at, held)) = last.as_ref()
			&& at.elapsed() < SCAN_TTL
		{
			return Arc::clone(held);
		}
		let held = Arc::new(scan());
		*last = Some((Instant::now(), Arc::clone(&held)));
		held
	}

	/// Classifies every open regular-file descriptor by its header, read
	/// through the existing descriptor: opening the file again would release
	/// the very locks this guards.
	fn scan() -> HashSet<(u64, u64)> {
		let mut held = HashSet::new();
		let Ok(entries) = fs::read_dir(FD_DIR) else {
			return held;
		};
		for entry in entries.flatten() {
			let Some(fd) = entry
				.file_name()
				.to_str()
				.and_then(|name| name.parse::<libc::c_int>().ok())
			else {
				continue;
			};
			let mut stat = MaybeUninit::<libc::stat>::uninit();
			// SAFETY: `stat` is writable for one `struct stat`. A descriptor
			// closed or reused since the listing only fails or describes
			// another file.
			if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
				continue;
			}
			// SAFETY: `fstat` succeeded, so it initialized `stat`.
			let stat = unsafe { stat.assume_init() };
			if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
				continue;
			}
			let mut header = [0u8; 16];
			// SAFETY: `header` is writable for its full length; `pread` leaves
			// the descriptor's offset untouched, so its owner is unaffected.
			let read = unsafe { libc::pread(fd, header.as_mut_ptr().cast(), header.len(), 0) };
			let Ok(read) = usize::try_from(read) else {
				continue;
			};
			if is_sqlite_header(&header[..read]) {
				#[allow(
					clippy::unnecessary_cast,
					reason = "same widening as `MetadataExt::{dev, ino}`; `dev_t`/`ino_t` are narrower \
					          or signed on some unix targets"
				)]
				held.insert((stat.st_dev as u64, stat.st_ino as u64));
			}
		}
		held
	}

	fn is_sqlite_header(header: &[u8]) -> bool {
		header == DB_MAGIC
			|| header
				.first_chunk::<4>()
				.is_some_and(|version| u32::from_ne_bytes(*version) == WAL_INDEX_VERSION)
	}
}
