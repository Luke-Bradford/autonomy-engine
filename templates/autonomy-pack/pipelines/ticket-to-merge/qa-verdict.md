Weigh the three checks' PR comments: must anything change before merge?
Write the verdict file: {"outcome": "failure"} sends the work BACK to the
coding loop with your comments as its input (the engine enforces a
3-bounce cap; the 4th failure parks the PR for a human);
{"outcome": "success"} sends it onward to the digest. Summarise your
reasoning as a PR comment either way.
