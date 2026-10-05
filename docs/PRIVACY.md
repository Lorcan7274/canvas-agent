# Privacy

This covers the canvas-agent planner server and the "Planner for Canvas" browser extension. The server is software you, or someone you trust, runs: there is no central service operated by the project. Whoever runs the server holds the data described below and is responsible for it. Nothing is sold, and there are no ads, analytics or tracking in either piece.

## In short

- Canvas is only ever read. Nothing is submitted, posted, messaged or changed there.
- The extension sends what it reads only to the one planner server you paired it with.
- The server passes data on only to services you or its operator turn on: your AI assistant, Google Calendar, and Anthropic (Claude) for estimates.
- You can delete everything: "Forget everything" in the extension, and "Delete my data" on the server's settings page.

## The browser extension

### What it reads

On Canvas sites (`*.instructure.com`, and any address of your school's Canvas you add), it checks that the page is Canvas and then makes GET requests to Canvas's API with your logged-in session:

- `/api/v1/users/self`, only to confirm that the site is Canvas and that you are signed in. Nothing from this answer is sent anywhere.
- Your active courses, your planner items from 14 days ago to 120 days ahead, your missing submissions, and the assignment and classic-quiz details the server asks for (at most 40 per sync).

It does not read your cookies itself: the browser attaches your Canvas session to those requests. It does not read the content of the pages you visit, other than looking for Canvas's own page markup, and it does not run on any other site. Instructure's own sites and Canvas beta and test copies (`*.beta.instructure.com`, `*.test.instructure.com`) are skipped.

### What it sends, and where

Only to the planner server you paired, over HTTPS (plain HTTP only to a server on your own computer), identified by a device token. Before anything leaves the browser it is cut down to the fields the planner uses:

- courses: id, name, course code, term name and end date;
- planner items and assignments: ids, title, due, unlock and lock dates, points, a link to the item on your Canvas, the assignment description, submission types, allowed attempts, whether peer review or group work is involved, and the number of rubric criteria (not their text);
- your submission state for each item: submitted, late, missing, excused or graded, and the score;
- your own planner marks (done, dismissed);
- quizzes: time limit and number of questions.

Never sent: your Canvas session or cookies, submission contents, comments, attachments, rubric text, discussion posts, LTI launch data, or anything from sites other than your Canvas.

### What it keeps in your browser

- Extension storage: the server's address, the device token, your Canvas addresses (and the ones you removed or the server refused), the last result of each sync, and which assistant the dashboard button opens.
- Session storage: a lock and progress counter while a sync runs, cleared when the browser closes.

### Permissions it asks for

- `storage`, `alarms` (a sync every 30 minutes while you are signed in to Canvas), `scripting` (to add the dashboard button on your school's own Canvas address).
- Access to `*.instructure.com`. Access to your school's own Canvas address and to the planner server is asked for only when you add them, and handed back when you remove them or choose "Forget everything".

### The "Plan my week" button

It opens the assistant chosen on the server's settings page (claude.ai, chatgpt.com, or an https address you set) with a fixed planning prompt. No Canvas data is put in that address. The chat itself is covered by that assistant's own privacy policy.

### Deleting

"Forget everything" on the options page removes the pairing, your Canvas addresses, sync results and the optional permissions from this browser; removing the extension does the same. The device token stays valid on the server until you remove the device on the server's settings page (Devices, Remove), which also ends its access.

## The server

### What it stores

- Your account: your email and name from Google sign-in (or the email typed into the development login), and your planning preferences (time zone, work windows, daily cap, block sizes, buffer, assistant).
- Canvas connections: the Canvas address and how it is connected. Personal access tokens and calendar feed URLs are encrypted (AES-256-GCM under the server's `SECRET_KEY`).
- Your coursework as read from Canvas through any connection: the fields listed above, with the description stored as text.
- Planning: estimates, the times you log, planned study blocks and, if Google Calendar is connected, the ids of the events written for them.
- Credentials: Google tokens are encrypted as above. Connector keys, device tokens, and the access and refresh tokens issued to assistants are stored only as SHA-256 hashes. Pairing codes expire after 15 minutes; sign-in sessions and assistant tokens expire too.
- Shared task cards: when model estimates are on, one card per assignment version per Canvas instance, made from the assignment's own record. A card holds no student identifier, and every student with that assignment shares it.

The server's log (standard error) records start-up settings, errors and sync summaries with Canvas host names and internal account ids. It is designed never to contain tokens, keys or assignment text.

### Who else receives data

- **Your AI assistant** (Claude, ChatGPT or another MCP client you connect): when you ask, the tools return your workload, estimates, check-ins and plans to it. That assistant's privacy policy covers what it does with them.
- **Google Calendar**, only if you connect it: the server writes study-block events titled "Study: *assignment* (*course*)" with a short description, the time and a link, into your primary calendar, and reads your free/busy times to plan around them.
- **Anthropic**, only if the server's operator sets `ANTHROPIC_API_KEY`: for each new or changed assignment, Claude receives its title, course code and name, kind, points, submission types, allowed attempts, rubric size, peer-review and group flags, quiz time limit and question count, and up to 6,000 characters of its description. It never receives your name, email, Canvas user id, due dates, scores or submissions. This happens under the operator's agreement with Anthropic.
- **Other students**: never anything of yours, except as part of a median time over at least five students who logged the same assignment on the same Canvas instance.

### How long it is kept

Everything is kept until you delete it or the operator deletes the database. Assignments that disappear from Canvas are hidden from planning and may stay stored until then. On the settings page you can remove a Canvas connection, revoke connector keys and devices, disconnect assistants and Google, or use **Delete my data**, which removes your account and every row stored for it in one step. Calendar events already written to Google Calendar stay there until you delete them. Shared task cards are not yours and are not deleted.

### Your school

Your school's acceptable-use policy applies to you. Some schools forbid third-party tools that read Canvas; check before you connect.
