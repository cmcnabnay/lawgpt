# Notes follow-up chat re-sending the whole document — 2026-11-11

All paths below are relative to `app/`.

## Summary

The chat box in the Notes tab lets you ask follow-up questions about a
report after it has been generated. Every follow-up question used to send
the full text of the reading again, along with the question. Once follow-ups
started resuming the same Claude Code conversation that generated the
notes, this meant a new copy of the whole reading was added to that
conversation on every turn. The conversation already had the reading from
the turn that generated the notes, so the copies were pure waste. They made
each follow-up slower and pushed long chats toward the model's context
limit.

The fix sends only the new question when a follow-up resumes an earlier
conversation. It landed for Claude Code on 2026-11-11 (`13e38ef`) and for
OpenAI on 2026-11-14 (`1b22458`).

## The pieces involved

- `sendNotesChatMessage()` (public/lawgpt.html) runs when you send a
  question in the Notes chat. It builds the request and sends it to the
  `POST /api/chat` endpoint (src/server.js).
- `buildNotesChatInput()` (public/lawgpt.html) builds the text of the
  prompt. When the follow-up is not resuming a conversation, the prompt
  includes the report's notes, the chat so far, and the question. When it
  is resuming, the prompt is only a short instruction and the question.
- `currentReport.documentIds` (public/lawgpt.html) lists the readings the
  report was generated from. The page sends these ids with every follow-up.
- `attachedDocuments` (src/server.js) is the server's list of those
  readings, with the full extracted text of each one.
- `claudeSessionId` (public/lawgpt.html and src/server.js) is the id of the
  Claude Code conversation that generated the report. Sending it back tells
  the server to resume that conversation instead of starting a new one.
- `runClaudeCode()` (src/server.js) starts the Claude Code CLI. With a
  `resumeSessionId` it runs `claude --resume <id>`, which continues the
  earlier conversation with all of its history, including the reading it
  was given.
- `openaiResponseId` (public/lawgpt.html and src/server.js) does the same
  job for OpenAI. It is the id of the earlier OpenAI response, and sending
  it as `previous_response_id` continues that conversation on OpenAI's side.

## How it worked over time

### Before 2026-09-20: every follow-up was a new conversation

1. `buildNotesChatInput()` (public/lawgpt.html) put the notes, the whole chat
   so far, and the question into the prompt.
2. `POST /api/chat` (src/server.js) looked up `attachedDocuments`
   (src/server.js) from the report's document ids and pasted the full text
   of every reading in front of the prompt.
3. The model started from nothing each time, so it needed all of this. The
   cost was that every question sent the entire reading, notes and history
   again.

### 2026-09-20 to 2026-11-11: resumed conversation, but the reading still sent (`a25f133`)

1. Follow-ups started sending `claudeSessionId` (public/lawgpt.html), and
   `runClaudeCode()` (src/server.js) resumed the conversation that generated
   the notes. That conversation already held the reading, the notes and every
   earlier follow-up.
2. `buildNotesChatInput()` (public/lawgpt.html) dropped the notes and history
   from the prompt on a resumed call, since the conversation already had
   them.
3. However, `POST /api/chat` (src/server.js) still pasted the full text of
   every reading from `attachedDocuments` (src/server.js) in front of the
   question.
4. So each follow-up added one more full copy of the reading to a
   conversation that already contained it. After five questions the
   conversation held the reading six times. This slowed each turn and moved
   long chats toward the context limit, even though nothing new was being
   given to the model.

### After the fix

#### Claude Code (`13e38ef`, 2026-11-11)

- In `POST /api/chat` (src/server.js), when `claudeSessionId` is present the
  prompt is just the question (`userPrompt = question`). The reading text is
  only built and sent when there is no conversation to resume, which is the
  first call that generates the notes.

#### OpenAI (`1b22458`, 2026-11-14)

- Generating a report now saves `openaiResponseId` (public/lawgpt.html) on
  the report, the same way `claudeSessionId` is saved.
- A follow-up on an OpenAI model sends that id. `POST /api/chat`
  (src/server.js) passes it to OpenAI as `previous_response_id` and sends
  only the instructions and the question. OpenAI already stores the earlier
  turns, including the attached readings.
- `truncation: "auto"` lets OpenAI drop the oldest turns instead of failing
  when a long chat outgrows the context window.
- OpenRouter keeps no conversation. If a request with an `openaiResponseId`
  would go to OpenRouter, `POST /api/chat` (src/server.js) returns a
  `session_unavailable` error instead of answering a bare question with no
  context.

#### Fallback

- `sendNotesChatMessage()` (public/lawgpt.html) retries once if the earlier
  conversation is gone (expired, deleted, or `session_unavailable`) or too
  long for the context window.
- The retry is a new conversation with the readings, the notes and the
  question, but no earlier chat history. The question still gets answered,
  and the report picks up the new conversation id for later follow-ups.

## Where the fix lives

- `src/server.js`: `POST /api/chat`, in the Claude Code branch
  (`userPrompt = question` when resuming) and the OpenAI
  `previous_response_id` branch; `runClaudeCode()` for `--resume`.
- `public/lawgpt.html`: `sendNotesChatMessage()` (which id to send, and the
  fallback retry) and `buildNotesChatInput()` (the short prompt used when
  resuming).
