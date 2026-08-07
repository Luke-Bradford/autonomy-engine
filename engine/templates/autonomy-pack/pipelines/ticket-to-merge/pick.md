Pick the next work item: the highest-priority open ticket labelled `ready`
(p1 before p2 before p3, oldest first) that no open PR already references.
Create the work branch for it (`feat/<n>-...` or `fix/<n>-...`) and push it
so later nodes can find it. Leave a one-line comment on the ticket saying
the pipeline picked it up.
