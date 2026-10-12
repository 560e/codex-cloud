# User guide

[简体中文](../PRODUCT.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

This guide covers daily workflows and task behavior. For setup, see [Local use](LOCAL.md) or [Deployment](DEPLOYMENT.md); for model access, see [Providers](PROVIDERS.md).

## Start with a project

After signing in, add an existing project or create a directory under an allowed root. Paths refer to the backend host, not the browser device. The service account needs access to the selected directory.

Project prompts can describe coding conventions, verification requirements and background. They accept up to 50,000 characters and do not enforce operating-system permissions. Removing a project removes its workbench index, not its source files.

Select a project, create a conversation and choose its model and execution permissions. Version control provides a useful baseline for inspecting edits. Plain directories also work, but lack a Git change baseline.

## Project context

At the top of Add project, the auto-compaction slider is always available, whether 1M context is checked or not. Choose 50%, 60%, 70%, 80% or 90% (default 90%). After each final response, the CLI checks this percentage against the current model's usable context window. Its existing compaction safeguards remain active.

Enabling 1M additionally requests a 1,000,000-token window and displays the corresponding token limit, such as 700,000 tokens at 70%. The model and provider must support that window. Settings persist per project and apply to creation, resume, fork and queued execution without modifying global CLI configuration. Existing indexed projects default to 1M off and 90%. See [Configuration](CONFIGURATION.md#per-project-context-settings) for CLI compatibility and exact overrides.

## Cross-conversation memory and collaboration

Two independent switches under **Settings → General → Memory and collaboration** are off by default. After enabling memory, use **Memory** in the sidebar to save project or instance-wide notes. You can also save a message as memory. Note content and scope can be edited; notes can also be disabled or deleted. Each turn includes at most six complete notes within a 4,000-character budget, and usage records contain only notes actually sent. Before an ordinary turn actually starts, the server selects relevant notes for the current project and message. Disabling memory stops future retrieval; text already present in native conversation history remains there. The memory list shows up to 500 recent notes; keyword retrieval scans up to 200 recent enabled notes in the applicable scopes. Semantic retrieval and pagination for larger memory collections are not implemented.

After enabling collaboration, use **Collaboration** in the sidebar to arrange existing conversations, including conversations from different projects. The conversation picker loads up to 10 pages (normally 600 conversations). Set a shared goal, instructions for each conversation, an optional next conversation and a maximum number of steps. Start a run with a task; each completed turn passes its final reply to the next conversation. A group may have only one unfinished run. Runs can be paused, resumed or stopped. Disabling the switch pauses further handoffs; an already running turn may still finish.

Handoffs contain text replies only. Attachments and access to other project files are not shared automatically. Check sensitive content before passing it on. Capacity contention pauses collaboration without adding an ordinary queue message; resume it after capacity becomes available. A restart, executor disconnect, uncertain submission or failed turn pauses the run for review instead of resending it. An uncertain run can be ended to cancel further handoffs, but its native task still needs checking in conversation history. Handoffs use final replies and exclude progress commentary. A participating conversation accepts one active collaboration run at a time; pause or stop it before sending an ordinary message there.

## Conversations and input

Conversations support pagination, pinning, renaming, forking, archiving and permanent deletion. Forking continues existing context along another route; it does not copy or isolate project files. Permanent deletion requires confirmation and does not undo project changes. Archived conversations are retained. Open **Settings → Archived conversations** to browse them by project and restore them to that project's recent list. Each project is paginated independently; Refresh reloads the current archive state.

With a conversation open, use the search icon at the top right of the workspace to find text in that conversation. The search shows the match count and jumps to the first match; Previous, Next, Enter and Shift+Enter cycle through matches. Older history pages are loaded before searching. If history loading fails, the UI explains that only loaded content can be searched. The New conversation button fills its row in the sidebar.

Messages can include uploads, quoted conversation text and project-file references. Each message accepts up to 10 attachments, 10 file references and 5 text references. Each upload is limited to 20 MiB. File references let the executor read server files as needed; uploads store local files in the workbench data directory.

Drafts live in the current browser tab's session storage, are cleared on logout and do not synchronize across devices. Attachments have separate server state. Check the target conversation before sending; a retained draft is not a submitted task.

## While a task runs

| Action              | Behavior                                                                     |
| ------------------- | ---------------------------------------------------------------------------- |
| Send                | Starts a new turn using its selected model                                   |
| Queue               | Persists a later task; normal completion advances it when scheduling permits |
| Steer               | Attempts to add instructions to the current turn, retaining its model        |
| Stop                | Requests an interrupt; completed file/tool operations are not undone         |
| Force-stop executor | Affects all tasks owned by this instance's executor                          |

Conversations in the same or different projects can run concurrently, sharing `MAX_CONCURRENT_TURNS` capacity (default 3). Each conversation runs one turn at a time and queues later messages. Same-project conversations share files without automatic workspace isolation. Failures, interruptions and service restarts pause affected queues for review before resuming. Closing the browser or losing connectivity normally does not stop backend execution.

Tasks may wait for command, file-change or permission approval, model questions or MCP input. Answer the actual request; a response already accepted from another page cannot take effect twice. Effective permissions and sandbox behavior depend on the CLI, operating system and selected policy. Project-selection roots are not an execution sandbox.

The UI displays streamed replies, tool records, plans, diffs and reasoning content supplied by the interface. After a delay or disconnect, inspect task state and history before sending the same task again.

Queued or paused messages can be edited with the pencil button beside the queue entry. The dialog loads the complete body, including text beyond the preview. Saving keeps attachments, references, model settings and queue position; a paused queue stays paused. Changes appear in other connected pages. If the message has begun submission or another page has changed it, saving is rejected and the draft remains visible for copying. Editing alone does not pause execution; already submitted messages cannot be changed through the queue.

## Inspect files and changes

The file panel provides browsing, text viewing, line/column links and downloads. Git diffs compare the current disk with a Git baseline; conversation diffs come from execution records. They may differ. Viewing a diff neither restores files nor replaces testing.

Images support drawer previews, enlargement, zoom and fit-to-window. Preview formats include PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG, up to 20 MiB. Text reads are limited to 2 MiB and directory pages to 1,000 entries. Download files when the UI reports an unsupported format, size limit or decoding failure. Preview formats and model image-input formats are separate capabilities.

Native code review and context compaction run through the CLI. Compaction changes model context; clearing the workbench cache is a different maintenance operation.

## Settings and maintenance

| Area                     | Purpose                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| General and appearance   | Theme and personal model filters                                     |
| Projects                 | Project prompts and directory management                             |
| Archived conversations   | Browse and restore archived conversations by project                 |
| Providers                | Profiles, catalog fetching, activation and supported balance queries |
| Extensions and migration | Skills, MCP and migration archives                                   |
| Runtime                  | CLI status and updates                                               |
| Data                     | Usage, cache and log maintenance                                     |
| Account                  | Website password and login management                                |

Cached input tokens are a subset of input tokens; reasoning tokens belong to output. Do not add either subset again. Usage statistics are not a provider invoice. See [Operations](OPERATIONS.md) for backup scope and recovery.

## Scope

The workbench serves users within a shared trust boundary. It does not provide member roles, tenant isolation, billing, GitHub OAuth, browser-based file rollback or cluster scheduling. Users share one operating-system service account and global provider configuration. Actual execution permissions determine accessible files, networks and commands.

## Export the current conversation

Open the top-right conversation menu and choose **导出当前会话** (Export current conversation), then select TXT, Markdown or HTML. The export includes the current conversation's full available history in chronological order, including older pages, messages, exposed reasoning, tool output and file diffs. It does not export other conversations or projects. A running reply is captured only as far as available during export.

TXT is readable plain text, Markdown retains message formatting, and HTML is a standalone page with formatted replies and printable tool output. Attachments and images retain references rather than embedded originals; HTML does not load remote images or execute content from messages. Empty conversations can also be exported. Reading history does not start a model task or query the provider balance. If a page fails, the dialog allows a retry and no partial file is downloaded.

## Preview project HTML

Open an `.html` or `.htm` file in the file panel to see its page, and use **预览 / 源码** (Preview / Source) to switch views. File links with line numbers open the source view directly. Refresh files to reload the page. Inline scripts, relative CSS/images/fonts/media and JavaScript modules are supported; HTTPS-hosted scripts, styles, images and fonts may also load.

The page runs in a sandbox without access to workbench cookies or its parent document. It does not provide a project backend, form submissions or an unrestricted API proxy. Relative resources resolve from the HTML file's project directory; root-absolute URLs and applications requiring their own routing/server should use the project's development server. Hidden files and non-static formats are not served. HTML is limited to 2 MiB and each asset to 20 MiB. Preview links expire after one hour and are revoked when the originating login session ends; refresh to create a new preview.
