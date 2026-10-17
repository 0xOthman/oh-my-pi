//! Helpers shared by the backends that materialize `merged` as a real
//! directory tree (rcopy, Linux reflink, Windows block clone) and by the
//! backends that validate a `lower` source directory.

use std::{
	ffi::OsStr,
	fs::{self, FileType},
	io,
	path::{Path, PathBuf},
};

use crate::{IsoError, IsoResult};

/// Resolves `path` against the current directory, checks that it is a
/// directory, and canonicalizes it when possible. `what` names the source in
/// error messages; `make_err` picks the error class, since some backends
/// report a bad source as unavailable so the caller falls back.
pub fn canonical_existing_dir(
	path: &Path,
	what: &str,
	make_err: fn(String) -> IsoError,
) -> IsoResult<PathBuf> {
	let resolved = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
	let meta = fs::metadata(&resolved)
		.map_err(|err| make_err(format!("invalid {what} {}: {err}", resolved.display())))?;
	if !meta.is_dir() {
		return Err(make_err(format!("{what} {} is not a directory", resolved.display())));
	}
	Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
}

/// Creates `merged`'s parent and clears whatever is at `merged` with `remove`,
/// so the walk starts from a fresh destination. `what` names the backend in
/// the error message.
pub fn prepare_destination(
	merged: &Path,
	what: &str,
	remove: impl FnOnce(&Path) -> io::Result<()>,
) -> IsoResult<()> {
	if let Some(parent) = merged.parent() {
		fs::create_dir_all(parent)
			.map_err(|err| IsoError::other(format!("create parent of {}: {err}", merged.display())))?;
	}
	remove(merged).map_err(|err| {
		IsoError::other(format!("unable to clear {} before {what}: {err}", merged.display()))
	})
}

/// Removes the directory tree, file, or symlink at `path`; a missing path is
/// not an error.
pub fn remove_existing(path: &Path) -> io::Result<()> {
	let result = match fs::symlink_metadata(path) {
		Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
		Ok(_) => fs::remove_file(path),
		Err(err) => Err(err),
	};
	match result {
		Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
		other => other,
	}
}

/// Recreates the symlink `src` at `dst` with the same target. `file_type` is
/// `src`'s own (unfollowed) type; Windows needs it to pick a directory or
/// file link.
pub fn copy_symlink(src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()> {
	let target = fs::read_link(src)
		.map_err(|err| IsoError::other(format!("read_link {}: {err}", src.display())))?;
	#[cfg(unix)]
	let res = {
		let _ = file_type;
		std::os::unix::fs::symlink(target, dst)
	};
	#[cfg(windows)]
	let res = if std::os::windows::fs::FileTypeExt::is_symlink_dir(&file_type) {
		std::os::windows::fs::symlink_dir(target, dst)
	} else {
		std::os::windows::fs::symlink_file(target, dst)
	};
	#[cfg(not(any(unix, windows)))]
	let res: io::Result<()> = {
		let _ = (target, file_type);
		Err(io::Error::new(io::ErrorKind::Unsupported, "symlink copy unsupported on this platform"))
	};
	res.map_err(|err| IsoError::other(format!("symlink {}: {err}", dst.display())))
}

/// Per-entry actions of [`copy_dir_contents`].
pub trait TreeCopy {
	/// Recreates the symlink `src` at `dst`.
	fn symlink(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()>;
	/// Copies any entry that is neither a directory nor a symlink.
	fn file(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()>;
	/// Runs after the directory `dst` has been filled from `src`.
	fn finish_dir(&self, src: &Path, dst: &Path) -> IsoResult<()>;
}

/// Directory filters for a single copy walk.
#[derive(Clone, Copy)]
pub struct CopyOptions<'a> {
	/// Entry names omitted at the walk root.
	pub skip:              &'a [&'a OsStr],
	/// Exclude nested directories with Git metadata.
	pub skip_nested_repos: bool,
	/// Absolute destination under the source, if any.
	pub excluded:          Option<&'a Path>,
}

/// Copies the entries of `src` into `dst` without following symlinks.
/// Root entries and nested repositories selected by `options` are omitted.
pub fn copy_dir_contents(
	src: &Path,
	dst: &Path,
	options: CopyOptions<'_>,
	copy: &impl TreeCopy,
) -> IsoResult<()> {
	let entries = fs::read_dir(src)
		.map_err(|err| IsoError::other(format!("read_dir {}: {err}", src.display())))?;
	for entry in entries {
		let entry =
			entry.map_err(|err| IsoError::other(format!("dir entry in {}: {err}", src.display())))?;
		let name = entry.file_name();
		if options.skip.contains(&name.as_os_str()) {
			continue;
		}
		let src_path = entry.path();
		let file_type = entry
			.file_type()
			.map_err(|err| IsoError::other(format!("file_type {}: {err}", src_path.display())))?;
		let dst_path = dst.join(&name);
		if file_type.is_symlink() {
			copy.symlink(&src_path, &dst_path, file_type)?;
		} else if file_type.is_dir() {
			if options.excluded == Some(src_path.as_path())
				|| (options.skip_nested_repos
					&& fs::symlink_metadata(src_path.join(".git"))
						.is_ok_and(|meta| meta.is_file() || meta.is_dir()))
			{
				continue;
			}
			fs::create_dir_all(&dst_path)
				.map_err(|err| IsoError::other(format!("create {}: {err}", dst_path.display())))?;
			copy_dir_contents(&src_path, &dst_path, CopyOptions { skip: &[], ..options }, copy)?;
			copy.finish_dir(&src_path, &dst_path)?;
		} else {
			copy.file(&src_path, &dst_path, file_type)?;
		}
	}
	Ok(())
}

/// Finds an in-source clone destination before it can be copied recursively.
/// Call before clearing the destination: it also rejects cloning onto an
/// ancestor of the source.
pub fn clone_excluded_path(lower: &Path, merged: &Path) -> IsoResult<Option<PathBuf>> {
	let parent = merged
		.parent()
		.ok_or_else(|| IsoError::other("clone destination has no parent"))?;
	fs::create_dir_all(parent)
		.map_err(|err| IsoError::other(format!("create parent of {}: {err}", merged.display())))?;
	let dest = fs::canonicalize(parent)
		.map_err(|err| IsoError::other(format!("canonicalize {}: {err}", parent.display())))?
		.join(
			merged
				.file_name()
				.ok_or_else(|| IsoError::other("clone destination has no name"))?,
		);
	if lower.starts_with(&dest) {
		return Err(IsoError::other("clone destination contains the source"));
	}
	Ok(dest.starts_with(lower).then_some(dest))
}

#[cfg(test)]
mod tests {
	use super::*;

	struct Copy;

	impl TreeCopy for Copy {
		fn symlink(&self, _: &Path, _: &Path, _: FileType) -> IsoResult<()> {
			unreachable!()
		}

		fn file(&self, src: &Path, dst: &Path, _: FileType) -> IsoResult<()> {
			fs::copy(src, dst).map_err(|err| IsoError::other(err.to_string()))?;
			Ok(())
		}

		fn finish_dir(&self, _: &Path, _: &Path) -> IsoResult<()> {
			Ok(())
		}
	}

	fn fixture() -> (PathBuf, PathBuf, PathBuf) {
		let root = std::env::temp_dir().join(format!(
			"pi-iso-clone-walk-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		));
		let source = root.join("source");
		let target = root.join("target");
		fs::create_dir_all(&source).unwrap();
		(root, source, target)
	}

	#[test]
	fn clone_walk_does_not_copy_linked_worktrees() {
		let (root, source, target) = fixture();
		fs::create_dir_all(source.join(".worktrees/a")).unwrap();
		fs::create_dir_all(source.join("vendor/repo/.git")).unwrap();
		fs::create_dir_all(source.join(".worktrees/cache")).unwrap();
		fs::create_dir_all(source.join(".git")).unwrap();
		fs::create_dir_all(&target).unwrap();
		fs::write(source.join(".worktrees/a/.git"), "gitdir: /original/.git/worktrees/a\n").unwrap();
		fs::write(source.join(".worktrees/cache/artifact"), "cache").unwrap();
		fs::write(source.join("vendor/repo/.git/config"), "config").unwrap();
		copy_dir_contents(
			&source,
			&target,
			CopyOptions {
				skip:              &[OsStr::new(".git")],
				skip_nested_repos: true,
				excluded:          None,
			},
			&Copy,
		)
		.unwrap();
		assert!(!target.join(".worktrees/a").exists(), "linked worktree was copied");
		assert!(!target.join("vendor/repo").exists(), "nested repository was copied");
		assert!(!target.join(".git").exists(), "source registration was copied");
		assert_eq!(fs::read_to_string(target.join(".worktrees/cache/artifact")).unwrap(), "cache");
		fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn clone_walk_excludes_destination_nested_in_source() {
		let (root, source, _) = fixture();
		let target = source.join(".worktrees/b");
		fs::create_dir_all(target.parent().unwrap()).unwrap();
		fs::write(source.join("file"), "checkout").unwrap();
		fs::write(source.join(".worktrees/cache"), "cache").unwrap();
		let excluded = clone_excluded_path(&source, &target).unwrap();
		fs::create_dir(&target).unwrap();
		copy_dir_contents(
			&source,
			&target,
			CopyOptions {
				skip:              &[],
				skip_nested_repos: true,
				excluded:          excluded.as_deref(),
			},
			&Copy,
		)
		.unwrap();
		assert_eq!(fs::read_to_string(target.join("file")).unwrap(), "checkout");
		assert_eq!(fs::read_to_string(target.join(".worktrees/cache")).unwrap(), "cache");
		assert!(!target.join(".worktrees/b").exists(), "destination was copied into itself");
		fs::remove_dir_all(root).unwrap();
	}
}
