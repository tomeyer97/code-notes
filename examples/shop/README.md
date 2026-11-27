# Lamp & Co: an example to try Code Notes on

A small fictional web shop: a page, an API, a worker and a payment client. It is here to be read, not run.
Open this folder in VS Code with Code Notes installed, open the Journeys list and click **Order and payment**.
The journey walks the code from the Buy now button to the paid order, one step at a time.
Its file is `journeys/place-order.json`; the code it points at is in `web/`, `api/`, `worker/` and `payments/`.

The code here is also what the repository's tests and the journey above point at, line by line: edit it and the
journey goes stale (`python3 skills/code-journey/scripts/journey.py check examples/shop place-order`, run in CI, says
so) and the golden tests fail. Treat it as frozen.
