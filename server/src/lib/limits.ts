/** Per-socket limits to reduce abuse and accidental runaway usage. */

export const MAX_USER_MESSAGE_CHARS = 32_000;

/** Max transcript turns kept in memory per socket (user + assistant entries). */
export const MAX_CONVERSATION_TURNS = 400;

/** Max raw audio bytes buffered for one STT session (OpenAISTT). */
export const MAX_STT_SESSION_BYTES = 30 * 1024 * 1024;

/** Max length for restore_session id string. */
export const MAX_RESTORE_SESSION_ID_LEN = 256;
