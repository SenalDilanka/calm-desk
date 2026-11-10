# Presage SmartSpectra Challenge: submission checklist

**Deadline: November 22, 11:59 PM PST** (that is **Nov 23, 1:29 PM** in Colombo, UTC+5:30). Winners are announced December 10.

Rules to keep in mind: one entry per person, no teams, 18+, and no diagnosis or treatment claims, medical decision-making, or covert/non-consensual monitoring.

## Things only you can do

- [ ] **Run it with your real API key** (`cp .env.example .env`, then `npm start`) and confirm live pulse, breathing and HRV appear and reach "Steady". This project could not reach Presage's service while being built, so this has not been verified with live data.
- [ ] **Check the breathing glow direction.** The warm glow ring should swell as your chest expands. If it moves the opposite way, set `TRACE_POLARITY = -1` at the top of `src/renderer/app.mjs`.
- [ ] **Check the telemetry statements against Presage's *Telemetry and Privacy* page** and edit the "What the SDK sends to Presage" row of the README if anything differs. The challenge says submissions without an accurate Consent and Data Handling section may be considered incomplete.
- [ ] **Record the demo video with the live camera, not `--simulate`.** Judges verify SDK use from the video and the repo, so make sure it clearly shows:
  1. The consent screen and ticking consent (and the optional expression box, if you demo it)
  2. Camera on, with the setup guidance reacting to your position or lighting
  3. The session: breathing ring, glow following your chest, live pulse / breathing / HRV tiles settling to "Steady"
  4. The summary, then **Save summary…** (open the JSON to show it is aggregate-only) and **Finish & discard data**
  5. A glimpse of `src/renderer/app.mjs` where the SDK is wired in
- [ ] **Public repository.** Make sure `.env` is not committed (it is git-ignored), and add a license for your own code. The SDK itself has its own license terms.
- [ ] **DEV post** from the submission template, tagged `#presagechallenge`. Under *Prize Categories* note **Best Thoughtful Real-World Use** (the consent and data-handling design is this project's strongest angle) and optionally **Most Creative or Delightful Use**. Copy the *Consent and Data Handling* section from the README into the post.
- [ ] *(Optional)* Upload an agent session transcript at dev.to/agent_sessions/new, hit **Make Public**, and check it first for keys and sensitive data.

## Suggested pacing (today is Nov 7)

| By | Goal |
| --- | --- |
| Nov 9 | First real-key run; fix glow direction and anything surprising |
| Nov 14 | Polish pass; record and edit the demo video |
| Nov 18 | Repo public, README final |
| Nov 20 | DEV post published, with a day or two of buffer before the deadline |
