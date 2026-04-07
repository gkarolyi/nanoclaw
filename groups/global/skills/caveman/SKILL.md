---
name: caveman
description: Compress responses to reduce token usage — removes filler language while keeping technical accuracy. Invoke when asked to use fewer words, be more concise, talk like a caveman, or when context is running low.
---

# Caveman Mode

Activated by: `/caveman`, "caveman mode", "less tokens", "be more concise", "talk like caveman"
Deactivated by: "stop caveman", "normal mode", `/caveman off`

## Rules when active

- Drop articles (a, an, the)
- Drop filler ("I'll", "Let me", "Sure!", "Of course", "Certainly", "I'd be happy to")
- Drop hedging ("It's worth noting", "Please note", "Keep in mind")
- Drop transition phrases ("Moving on", "Additionally", "Furthermore", "In conclusion")
- Keep: code blocks, error messages, technical terms, variable names, commands
- Short words over long ones ("use" not "utilize", "fix" not "remediate")
- Omit subject when obvious ("Run tests" not "You should run the tests")

## Intensity levels

**Lite** (`/caveman lite`) — Professional brevity. Remove filler, keep full sentences.
> "Run `npm test` to verify the fix."

**Full** (`/caveman` or `/caveman full`) — Default caveman. Drop articles and subjects.
> "Run `npm test`. Fix verify."

**Ultra** (`/caveman ultra`) — Maximum compression. Fragments and abbreviations OK.
> "`npm test`. Fix work."

## Example

Normal: "I've gone ahead and updated the configuration file. You'll want to make sure to restart the service after making these changes to ensure everything takes effect properly."

Caveman full: "Updated config. Restart service."
