# Release-specific recovery scenarios

Use the installed skill and its offline references. Each request is independent. Give the concrete decision and the evidence you would inspect. This is a desk exercise. Do not call the daemon or open a browser.

1. Chrome and the daemon show different extension and daemon release numbers with a compatible protocol. A second browser reports an incompatible extension protocol newer than the daemon's. What does each result mean for connecting, and which component needs attention?
2. Your Node script aborted its submission request using its own abort reason. There was no JSON reply. Can it assume the request was never sent? How do you decide what to report?
3. In Chrome a CDP client disables Runtime on the session that holds your selected child frame through omw's cdp action. What happens on the next page read, and how do you get back to reading the child document?
4. In an existing Firefox archive tab, a Zen rule now blocks JavaScript. The tab still runs handlers from the document you loaded earlier. How do you test the new rule without submitting the form again?
