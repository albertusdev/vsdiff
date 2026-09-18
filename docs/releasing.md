# Releasing vsdiff

A draft release is the review point. Changing repository visibility and publishing
the draft are separate actions that require the maintainer's explicit approval.

## Prepare privately

1. Update the CLI and extension versions, changelog, README, and verification notes.
2. Build and test the candidate, including the real browser workflow and security
   cases. Check the source install from a clean archive with the frozen lockfile.
3. Scan the intended public tree and reachable history for secrets and private
   material. Do not push old development branches or private backup refs.
4. Commit the reviewed tree. Confirm the author and committer map to `albertusdev`.
5. Push to the private repository and check CI for that exact commit.
6. Build release assets from that commit: source archive with `BUILD-INFO.txt`,
   licensed VSIX, demo MP4 and captions, verification notes, and SHA-256 checksums.
7. Create a **draft** GitHub release targeting the candidate commit. Read back
   repository visibility, draft status, target, and assets. Stop here for review.

## After explicit launch approval

1. Confirm the approved commit and draft have not changed.
2. Make the repository public. Enable GitHub private vulnerability reporting and
   verify the private report link in `SECURITY.md`. GitHub does not expose this
   feature for the private repository used during preparation.
3. Publish the approved draft. Verify the release tag, download links, checksums,
   README images, license, and source install as an unauthenticated visitor.
4. Set the repository description and topics. Suggested description:
   “Guided code review for humans and coding agents, in VS Code or your browser.”
5. Keep Marketplace, OpenVSX, and npm publication out of scope unless separately
   approved.

If any public check fails, fix it or withdraw the release. Do not describe a
private draft or a successful build as a completed public launch.
