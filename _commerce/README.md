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
- Production startup is deliberately rejected until production safety gates are implemented.
- GitHub Pages excludes this directory; it cannot host the running backend.

Use Node 22 LTS (`.nvmrc`). Runtime setup and verified commands will be recorded as this first round is completed. Do not run default seed scripts or put customer/merchant credentials in the repository.
