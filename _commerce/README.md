# PawShop self-hosted commerce foundation

Local development only. Medusa 2.19 core and admin are self-hosted; no Shopify or Medusa Cloud subscription is required by this project. Hosting, maintenance and payment-provider charges remain separate future decisions.

- Preserve the existing live storefront. This backend is not connected to it.
- PostgreSQL runs in an isolated local cluster on 127.0.0.1:54329.
- Real secrets, database files and backups live outside this repository.
- All Store APIs and customer authentication are closed in this round.
- No demo products, external payment service or shipping promise is configured.
  Medusa creates local system-default modules and a publishable-key fixture, but
  none can collect money and Store APIs are hard-blocked even when that valid key
  is supplied.
- Production startup is deliberately rejected unless the private topology,
  durable Redis modules, object storage, host sizing and migration gate validate.
- GitHub Pages excludes this directory; it cannot host the running backend.

Use Node 22 LTS (`.nvmrc`). Runtime setup and verified commands will be recorded as this first round is completed. Do not run default seed scripts or put customer/merchant credentials in the repository.

The selected low-cost production topology is `single-host-private`: PostgreSQL,
Redis and the Medusa API must bind to `127.0.0.1`; the owner dashboard is reached
through an SSH tunnel and is not published on the Internet. Product media still
uses S3-compatible object storage so releases and rollbacks cannot erase uploads.
The current approximately 1 GB server fails the enforced nominal 2 GB RAM gate
and must not run this backend yet.
