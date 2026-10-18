/**
 * The supplied size-based generator writes one complete final record after
 * crossing its target. Its current bounded vocabulary has a maximum CRLF
 * record size of 120 bytes; 128 bytes leaves a narrow, explicit margin for
 * that completion record without turning the upload limit into an unbounded
 * or memory-based allowance.
 */
export const MAX_GENERATOR_FINAL_RECORD_HEADROOM_BYTES = 128;
export const MAX_FILE_TARGET_BYTES = 2 * 1024 ** 3;
export const MAX_FILE_BYTES = MAX_FILE_TARGET_BYTES + MAX_GENERATOR_FINAL_RECORD_HEADROOM_BYTES;
export const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 16 * 1024 ** 2;
export const MAX_FILES_PER_REQUEST = 8;
export const MAX_MULTIPART_PARTS = MAX_FILES_PER_REQUEST + 4;
export const MAX_MULTIPART_FIELDS = 4;
export const MAX_FIELD_BYTES = 16 * 1024;
export const MAX_FILENAME_BYTES = 1024;
export const MAX_SIMULTANEOUS_UPLOADS = 4;
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;
export const MAX_CSV_RECORD_BYTES = 1024 * 1024;
export const STAGING_BATCH_SIZE = 500;
export const PROCESSOR_POLL_MS = 250;
export const PROGRESS_UPDATE_ROWS = 500;
export const LEASE_DURATION_SECONDS = 30;
export const LEASE_HEARTBEAT_MS = 5_000;
