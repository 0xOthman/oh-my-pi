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
//! Every check reads the descriptor table at the time of the call, so a
//! connection opened a moment earlier is never missed:
//! - [`held_by_sqlite`] answers by path before anything is opened (writes,
//!   copies, JS readers).
//! - Read-only [`open`]s sniff the new descriptor's header instead, which keeps
//!   the per-file cost of a walk at one `fstat`+`pread`; a SQLite file another
//!   descriptor in this process also holds is refused, and the new descriptor
//!   is *kept open* rather than closed, since closing it is exactly what
//!   releases the locks. Later opens of that inode are refused before any
//!   descriptor exists, and the kept descriptors close once no other descriptor
//!   holds the inode.
//!
//! Windows locks are per handle, so nothing is refused there.

use std::{fs, io, path::Path};

use crate::options::OpenOptions;

/// Whether `path` is a SQLite database or WAL index this process holds open.
///
/// Only an open+close outside SQLite endangers such a file; opening it
/// through SQLite is safe because SQLite defers its own closes while locks
/// are held. Missing paths and non-regular files never match.
pub fn held_by_sqlite(path: &Path) -> bool {
	imp::held_by_sqlite(path)
}

/// Opens host `path` unless closing the result later would release the POSIX
/// locks of this process's own SQLite connection (see [`held_by_sqlite`]).
///
/// # Errors
/// [`io::ErrorKind::ResourceBusy`] when `path` is a SQLite file this process
/// holds open; otherwise whatever the host `open` reports.
pub(crate) fn open(path: &Path, options: &OpenOptions) -> io::Result<fs::File> {
	if options.is_writable() || options.is_truncate() {
		// Header sniffing needs a readable descriptor and comes too late for a
		// truncating open, so writers ask by path first.
		if held_by_sqlite(path) {
			return Err(busy());
		}
		return options.to_std().open(path);
	}
	imp::open_for_reading(path, options)
}

pub(crate) fn busy() -> io::Error {
	io::Error::new(
		io::ErrorKind::ResourceBusy,
		"SQLite database held open by this process; opening it outside SQLite would release the \
		 connection's locks",
	)
}

#[cfg(not(unix))]
mod imp {
	use std::{fs, io, path::Path};

	use crate::options::OpenOptions;

	pub(super) const fn held_by_sqlite(_path: &Path) -> bool {
		false
	}

	pub(super) fn open_for_reading(path: &Path, options: &OpenOptions) -> io::Result<fs::File> {
		options.to_std().open(path)
	}
}

#[cfg(unix)]
mod imp {
	use std::{
		fs, io,
		mem::MaybeUninit,
		os::{
			fd::{AsRawFd, OwnedFd, RawFd},
			unix::fs::{FileExt, MetadataExt},
		},
		path::Path,
	};

	use parking_lot::Mutex;

	use crate::options::OpenOptions;

	#[cfg(any(target_os = "linux", target_os = "android"))]
	const FD_DIR: &str = "/proc/self/fd";
	#[cfg(not(any(target_os = "linux", target_os = "android")))]
	const FD_DIR: &str = "/dev/fd";

	/// Main database header: `"SQLite format 3\0"`.
	const DB_MAGIC: &[u8; 16] = b"SQLite format 3\0";
	/// `iVersion` that opens a WAL-index (`-shm`) header, stored in native
	/// byte order.
	const WAL_INDEX_VERSION: u32 = 3_007_000;

	/// `(dev, ino)` of a host file.
	type Inode = (u64, u64);

	/// Descriptors a read open found on a held SQLite inode and kept instead
	/// of closing, keyed by that inode. Only the first open of each held inode
	/// lands here; later ones are refused by path.
	static KEPT: Mutex<Vec<(Inode, OwnedFd)>> = Mutex::new(Vec::new());

	pub(super) fn held_by_sqlite(path: &Path) -> bool {
		let Ok(meta) = fs::metadata(path) else {
			return false;
		};
		if !meta.is_file() {
			return false;
		}
		let kept = kept_fds(&KEPT.lock());
		holders((meta.dev(), meta.ino()), &kept)
			.into_iter()
			.any(fd_has_sqlite_header)
	}

	pub(super) fn open_for_reading(path: &Path, options: &OpenOptions) -> io::Result<fs::File> {
		if refuses_kept_inode(path) {
			return Err(super::busy());
		}
		let file = options.to_std().open(path)?;
		let Some(inode) = sqlite_inode(&file) else {
			return Ok(file);
		};
		let mut kept = KEPT.lock();
		let mut ignored = kept_fds(&kept);
		ignored.push(file.as_raw_fd());
		if holders(inode, &ignored).is_empty() {
			return Ok(file);
		}
		kept.push((inode, OwnedFd::from(file)));
		Err(super::busy())
	}

	/// Refuses `path` while it names an inode with kept descriptors and
	/// another descriptor still holds it; once none does, the kept descriptors
	/// close (no locks left to release) and the open proceeds.
	fn refuses_kept_inode(path: &Path) -> bool {
		let mut kept = KEPT.lock();
		if kept.is_empty() {
			return false;
		}
		let Ok(meta) = fs::metadata(path) else {
			return false;
		};
		let inode = (meta.dev(), meta.ino());
		if !kept.iter().any(|(kept_inode, _)| *kept_inode == inode) {
			return false;
		}
		if !holders(inode, &kept_fds(&kept)).is_empty() {
			return true;
		}
		kept.retain(|(kept_inode, _)| *kept_inode != inode);
		false
	}

	fn kept_fds(kept: &[(Inode, OwnedFd)]) -> Vec<RawFd> {
		kept.iter().map(|(_, fd)| fd.as_raw_fd()).collect()
	}

	/// `(dev, ino)` of `file` when it is a regular file with a SQLite header.
	fn sqlite_inode(file: &fs::File) -> Option<Inode> {
		let meta = file.metadata().ok()?;
		if !meta.is_file() {
			return None;
		}
		let mut header = [0u8; 16];
		let read = file.read_at(&mut header, 0).ok()?;
		is_sqlite_header(&header[..read]).then(|| (meta.dev(), meta.ino()))
	}

	/// Open descriptors of this process on `inode`, other than `ignored`.
	fn holders(inode: Inode, ignored: &[RawFd]) -> Vec<RawFd> {
		let Ok(entries) = fs::read_dir(FD_DIR) else {
			return Vec::new();
		};
		entries
			.flatten()
			.filter_map(|entry| entry.file_name().to_str()?.parse::<RawFd>().ok())
			.filter(|fd| !ignored.contains(fd) && fd_inode(*fd) == Some(inode))
			.collect()
	}

	fn fd_inode(fd: RawFd) -> Option<Inode> {
		let mut stat = MaybeUninit::<libc::stat>::uninit();
		// SAFETY: `stat` is writable for one `struct stat`. A descriptor closed
		// or reused since the listing only fails or describes another file.
		if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
			return None;
		}
		// SAFETY: `fstat` succeeded, so it initialized `stat`.
		let stat = unsafe { stat.assume_init() };
		#[allow(
			clippy::unnecessary_cast,
			reason = "same widening as `MetadataExt::{dev, ino}`; `dev_t`/`ino_t` are narrower or \
			          signed on some unix targets"
		)]
		(stat.st_mode & libc::S_IFMT == libc::S_IFREG)
			.then_some((stat.st_dev as u64, stat.st_ino as u64))
	}

	/// Whether `fd`'s file starts with a SQLite header, read without moving
	/// the descriptor's offset.
	fn fd_has_sqlite_header(fd: RawFd) -> bool {
		let mut header = [0u8; 16];
		// SAFETY: `header` is writable for its full length; `pread` leaves the
		// descriptor's offset untouched, so its owner is unaffected.
		let read = unsafe { libc::pread(fd, header.as_mut_ptr().cast(), header.len(), 0) };
		usize::try_from(read).is_ok_and(|read| is_sqlite_header(&header[..read]))
	}

	fn is_sqlite_header(header: &[u8]) -> bool {
		header == DB_MAGIC
			|| header
				.first_chunk::<4>()
				.is_some_and(|version| u32::from_ne_bytes(*version) == WAL_INDEX_VERSION)
	}
}
