---
"oh-my-webbridge": patch
---

# Report how far failed commands got

The daemon distinguishes commands cancelled before sending from commands that ended while waiting for a browser reply. The CLI includes the fault code in stderr and preserves the structured reply on stdout.
