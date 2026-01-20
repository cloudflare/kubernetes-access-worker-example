# Cloudflare Zero Trust Kubernetes Proxy

This repository contains a reference implementation for securely exposing a
Kubernetes API server using **Cloudflare Zero Trust**, **Cloudflare Workers**,
and **Terraform**.

Unlike a traditional VPN, this architecture places a Cloudflare Worker on the
public internet, strictly shielded by Cloudflare Access. Users authenticate
using their enrolled WARP client in your Zero Trust organization; Cloudflare
Access reuses this authenticated WARP session to automatically authorize
requests to the Worker for a configured [session
duration](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/warp/configure-warp/warp-sessions/#configure-warp-sessions-in-access).
Once authorized, Access injects a signed JWT into the request headers; the
Worker then cryptographically validates this token to confirm the user's
identity before proxying traffic to your Kubernetes API server using
[Impersonation
headers](https://kubernetes.io/docs/reference/access-authn-authz/authentication/#user-impersonation).

## 🏗 Architecture

The flow of a request is as follows:

1.  **Developer** runs `kubectl` on their laptop (connected to Cloudflare WARP).
2.  **WARP** captures the request and attaches a secure device session identity.
3.  **Cloudflare Access** checks the Zero Trust policy (i.e., "Must have valid
    WARP session") before sending the traffic to the Worker.
4.  **Cloudflare Worker** (this [code](./src/index.ts)):
      * Validates the Access JWT.
      * Maps the user `email` to a Kubernetes identity (User/Group).
      * Establishes a secure, private connection to the cluster via Cloudflare
        Tunnel and [Workers VPC (WVPC)](https://developers.cloudflare.com/workers-vpc/).
      * Injects [Impersonation headers](https://kubernetes.io/docs/reference/access-authn-authz/authentication/#user-impersonation).
      * Handles WebSocket upgrades for streaming commands (`kubectl exec`, `logs -f`).
5.  **Kubernetes API** receives the request. Once the Kubernetes API server
    verifies the pod's Service Account has permission to `impersonate` (e.g.
    `ClusterRole` with `impersonate` verb), it switches contexts and applies
    standard Kubernetes RBAC policies to the request effectively as if User X
    and Group Y had initiated it directly.

## ⚡️ The Worker (`/src`)

The heart of this solution is the Cloudflare Worker. It is responsible for
bridging the gap between HTTP-based Zero Trust auth and Kubernetes-native RBAC.

### Key Features

  * **Identity Mapping:** Translates enrolled Zero Trust user's email (e.g. `alice@mydomain.com`) into a Kubernetes User (e.g. `alice`) and Groups (e.g. `system:masters`, `developers`).
  * **Header Sanitization:** Removes dangerous headers to prevent spoofing and strips internal Cloudflare trace headers before they reach the cluster.
  * **WebSocket Support:** Full support for interactive `kubectl` commands (exec, attach, port-forward) by manually handling the WebSocket handshake and subprotocol negotiation.
  * **Security:** Verifies the JWT signature against your Team's JWKS to ensure requests are legitimate.

## ☁️ Infrastructure (Terraform)

The `/terraform` directory uses a modular approach to provision the entire
stack.

### 1. DigitalOcean Cluster ([`modules/digitalocean`](./terraform/modules/digitalocean))

  * Provisions a managed Kubernetes (DOKS) cluster for demo purposes.
  * Configures VPC and node pools.

### 2. Kubernetes Resources ([`modules/k8s`](./terraform/modules/k8s))

  * **Cloudflare Tunnel:** Creates the [Cloudflare
    Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
    and credentials.
  * **Tunnel Pod (Sidecar Architecture):** Deploys a single Pod containing two
    containers to bridge traffic from the edge to the API server:
      * **Container 1 (`cloudflared`):** Establishes the encrypted outbound
        tunnel to Cloudflare. It receives traffic from the edge and forwards it
        locally via plaintext HTTP to the sidecar (traffic is fully encrypted in
        transit through the tunnel).
      * **Container 2 (`kubectl proxy`):** Runs the [`kubectl
        proxy`](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_proxy/)
        command. It listens for the plaintext traffic from `cloudflared` and
        proxies it to the actual upstream Kubernetes API Server. This sidecar
        validates the Kube API's TLS certificate.
  * **Service Account:** Creates the high-privilege Service Account the Worker
    uses to "impersonate" other users. It is bound to the pod; the Worker does
    not see the secret `ServiceAccount` token.
  * **RBAC:** Binds the necessary `ClusterRole` to allow the pod to perform
    impersonation.

### 3. Worker Infrastructure ([`modules/worker`](./terraform/modules/worker))

  * **Worker Custom Domain:** Maps the Worker to a custom domain (e.g.,
    `kube.mydomain.com`). This is a prerequisite for placing the Worker
    behind Cloudflare Access.
  * **Access Application:** Protects the Worker's public endpoint by enforcing
    Zero Trust policies. It strictly verifies that incoming requests have a
    valid, authenticated WARP session before they ever reach the Worker code.
  * **Workers VPC Service:** Configures a [Workers VPC
    Service](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)
    to create a secure, private binding (`env.KUBE_API`). This allows the Worker
    to communicate directly with the Cloudflare Tunnel inside the cluster over a
    private network, ensuring traffic between the proxy and the cluster never
    traverses the public internet.
  
## 🚀 Deployment Guide

### 🛠️ Step 0: Prerequisites & Setup

**Prerequisites:**
* **Zero Trust Admin:** You must be an Administrator in your [Cloudflare Zero Trust Organization](https://developers.cloudflare.com/cloudflare-one/setup/).
* **Cloudflare Zone:** You need an active domain onboarded to Cloudflare. This
  is required to assign a public custom domain (e.g., `kube.mydomain.com`) to the
  Worker later.
    * *Guide: [Add a site to Cloudflare](https://developers.cloudflare.com/fundamentals/setup/manage-domains/add-site/)*
* **WARP sessions:** Enable `WARP authentication identity` as an allowed login
  method in your Zero Trust Organization. This allows users to log in to Access
  applications using their WARP session.
  * *Guide: [Configure WARP sessions in Access](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/warp/configure-warp/warp-sessions/#configure-warp-sessions-in-access)*

**Required Tools:**
* [Node.js](https://nodejs.org/) & [npm](https://www.npmjs.com/)
* [Terraform](https://developers.cloudflare.com/terraform/installing/)

Before interacting with the Worker or deploying infrastructure, you must install
the project dependencies. This ensures `wrangler` and the necessary TypeScript
types are available locally.

1.  **Navigate to the project root:**

    ```bash
    cd kubernetes-access-worker-example
    ```

2.  **Clean Install Dependencies:** Use `npm ci` (Clean Install) to ensure you
    install the exact versions defined in the `package-lock.json` file,
    preventing version mismatch errors during deployment.

    ```bash
    npm ci
    ```

#### 🧠 Configuring Identity Mapping

The Worker contains a hardcoded lookup table that translates a user's email into
a specific **Kubernetes User and Group**. This is the core logic that determines
"Who is this person inside the cluster?"

By default, the code includes a placeholder for demonstration. You **must**
update this to match your actual team members and their desired permissions.

1.  Open [`src/index.ts`](./src/index.ts).
2.  Locate the `IDENTITY_MAP` constant.
3.  Add entries for your team members, assigning them to the appropriate
    Kubernetes RBAC groups (e.g., `system:masters` for admins, `view` for
    developers).

##### ⚙️ Advanced: Custom Identity Logic

For more dynamic control, you can modify the `mapAccessIdentityToK8s` function
in `src/index.ts`. This function is the central decision point for
authorization; you can extend it to look up identities in Cloudflare KV, an
external database, or apply regex patterns to specific teams.

**⚠️ Important: Remove Demo Logic** Out of the box, this function contains a
**catch-all demo rule** that grants `system:masters` (superuser) privileges to
**any** user with a `@mydomain.com` email address.

```typescript
// src/index.ts

// 🚨 TODO: REMOVE THIS BLOCK FOR PRODUCTION 🚨
if (claims.email.endsWith("@mydomain.com")) {
  return {
    accessJwtIdentity: claims.email,
    // Does not matter since group is superuser, but still required for
    // impersonation to specify username
    user: "foobar",
    groups: ["system:masters"],
  };
}
```

Before deploying to a real environment, you **must remove or update this
block**. If you want to rely strictly on the `IDENTITY_MAP` defined above,
delete this `if` statement entirely to ensure only explicitly allowed users can
access the cluster.

##### Example Configuration

```typescript
const IDENTITY_MAP: Record<string, K8sIdentity> = {
  // Admin User: Grants full cluster control
  "alice@mydomain.com": {
    user: "alice", 
    groups: ["system:masters"] 
  },

  // Developer User: Grants read-only access (assuming you have a 'view-only' ClusterRole)
  "bob@mydomain.com": {
    user: "bob",
    groups: ["view", "system:authenticated"]
  }
};
```

### ⚡ Step 1: Bootstrap

This project requires a **two-stage deployment**. We must deploy the Worker
first (even with invalid environment variables) so that Terraform can locate the
Worker script and attach the necessary resources (Custom Domains, Access
Application) to it.

1.  **Authenticate:** Log in to your Cloudflare account.

    ```bash
    npx wrangler login
    ```

    *Ensure your user has
    [permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/#account-permissions)
    to create and edit Workers (`Workers Scripts Write`).*

2.  **Configure Identity & Routes:** Open `wrangler.toml` and update the
    configuration to match your Cloudflare account and network settings.

      * **`account_id`**: Cloudflare account ID. Found on the right sidebar of
        the Cloudflare Dashboard.
      * **`routes`**: Defines the public DNS record where this Worker will be
        accessible (must match the Zone you are deploying to).
      * **`ACCESS_TEAM_DOMAIN`**: Your Cloudflare Zero Trust URL (used to fetch
        keys for JWT validation).

    ```toml
    # wrangler.toml

    # Update with your Cloudflare account ID
    account_id = "<CLOUDFLARE_ACCOUNT_ID>"

    # Update with your Cloudflare zone and desired subdomain
    routes = [{ pattern = "kube.mydomain.com/*", zone_name = "mydomain.com" }]

    [vars]
    # Don't modify other [vars]
    # ...
    # Update with your Zero Trust org team domain
    ACCESS_TEAM_DOMAIN = "https://my-zt-org.cloudflareaccess.com"
    ```

3.  **Initial Deploy:** Push the code to create the Worker placeholder.

    ```bash
    npx wrangler deploy
    ```

    *(Note: The Worker will technically be "live" but will fail requests until
    the Terraform infrastructure (Step 2) is applied and more environment
    variables are set.)*

### 🏗️ Step 2: Infrastructure Setup

Terraform is used to deploy the infrastructure relevant to this project.

#### 🔑 Cloudflare API Token Permissions

To successfully provision all resources (Tunnel, Worker, Access, and DNS), you
must provision a Cloudflare API Token with sufficient privileges. We strongly
recommend creating an **Account-Owned Token**. 

Create a Custom Token with the following permissions:

**Account Permissions:**
* `Connectivity Directory` > `Edit`
* `Cloudflare Tunnel` > `Edit`
* `Zero Trust` > `Edit`
* `Workers Scripts` > `Edit`
* `Access: Apps and Policies` > `Edit`

**Zone Permissions:**
* `Zone` > `Read`
* `DNS` > `Edit`

**Zone Resources:**
* Set to **Include** > **Specific Zone** > Select your target domain (e.g., `mydomain.com`).

#### ☸️ Bring Your Own Cluster (BYOC)

By default, this project provisions a fresh DigitalOcean Kubernetes cluster for
demo purposes. If you prefer to use an existing cluster (e.g., AWS EKS, GKE, or
a local Minikube), you must manually update the Terraform configuration to
bypass the infrastructure provisioning:

1.  **Disable the Infrastructure Module:** Open [`main.tf`](./terraform/main.tf) and comment out the
    entire `module "digitalocean" { ... }` block.
2.  **Remove Dependencies:** In the `module "k8s"` block, remove the line
    `depends_on = [module.digitalocean]`.
3.  **Update Variables:** Open [`variables.tf`](./terraform/variables.tf). Remove
    the `do_token` variable block.
4.  **Update Providers:** Open [`providers.tf`](./terraform/providers.tf).
    Remove the `digitalocean` provider configuration and update the `kubernetes`
    provider to point to your local kubeconfig file (or specific cloud context).

Use the following configuration to target your current active cluster context:

```hcl
# providers.tf

provider "kubernetes" {
  config_path    = "~/.kube/config"
  # Optional: Specify a context if not using current
  config_context = "your-context" 
}
```

### 🛡️ Access Policy Configuration

By default, the Terraform module creates a basic Access Policy for the Worker.
You must customize this to define exactly **who** in your organization is
allowed to reach the proxy worker and therefore the Kubernetes API.

1.  **Locate the Resource:** Open
    [`terraform/modules/worker/main.tf`](./terraform/modules/worker/main.tf).
2.  **Find the Policy:** Look for the `resource
    "cloudflare_zero_trust_access_policy" "policy"` block.
3.  **Update the `include` block:** Modify the rules to match your
    organization's security groups.

#### Example Configurations

**Option A: Allow specific admins (Good for testing)**

```hcl
resource "cloudflare_zero_trust_access_policy" "policy" {
  # ... existing config ...
  decision = "allow"

  include = [
    { email = { email = "alice@mydomain.com" }},
    { email = { email = "bob@mydomain.com" }}
  ]
}
```

**Option B: Allow an Access Group (Best Practice)**

We recommend creating a "Platform Engineers" group in your Zero Trust dashboard
and referencing it here by UUID. This keeps your Terraform code clean and allows
you to manage membership via your IdP.

```hcl
resource "cloudflare_zero_trust_access_policy" "policy" {
  # ... existing config ...
  decision = "allow"

  include [{
    group = { id = "044513ec-5875-4fce-87bd-a75f658fd9de" }
  }]
}
```

**Option C: Allow entire email domain (Broad access)**

```hcl
resource "cloudflare_zero_trust_access_policy" "policy" {
  # ... existing config ...
  include = [{
    email_domain = { domain = "your-company.com" }
  }]
}
```

#### ▶️ `terraform apply`

Navigate to the terraform directory and run `terraform apply`.

***

> **⚠️ Security Warning: Protect Your State File**
>
> When running Terraform locally, your state is stored in a `terraform.tfstate`
> file. This file contains **unencrypted sensitive data**, including your
> Cloudflare API tokens, Tunnel secrets, and Kubeconfig credentials.
>
> * **Do not commit** `terraform.tfstate` or `terraform.tfstate.backup` to
>   version control.
> * Ensure these files are listed in your `.gitignore`.
> * For production environments, use a secure [Remote
>   Backend](https://developer.hashicorp.com/terraform/language/settings/backends/remote)
>   (like Terraform Cloud or S3 with encryption) instead of local state.

***

```bash
cd terraform
terraform init
terraform apply
```

*Note: You will need to provide your Cloudflare API Token, Account ID, and
DigitalOcean Token as input variables.*

### 🔗 Step 3: Bind WVPC & Final Deploy

With the infrastructure successfully provisioned, you must now connect the
Worker to your new resources. You will use `terraform output` to retrieve the
relevant configuration data.

#### ⚙️ Update Configuration

Open `wrangler.toml` and update the `[vars]` and `[[vpc_services]]` sections
using the values from your Terraform state:

```toml
# wrangler.toml

[vars]
# Don't modify other [vars]
# ...
# Application Audience (AUD) Tag for the Access Application protecting this worker.
# Retrieve with: terraform output -raw access_aud
ACCESS_AUD = "<AUD_TAG>"

# Uncomment this entire block and update the `service_id` with your WVPC service ID.
[[vpc_services]]
binding = "KUBE_API"
# The ID of the Workers VPC Service created by Terraform.
# Retrieve with: terraform output -raw wvpc_service_id
service_id = "<WVPC_SERVICE_ID>"
remote = true
```

#### 🚀 Final Deployment

**Note**: Before deploying, ensure the Cloudflare user authenticated in your
terminal (via `wrangler login`) possesses the `Connectivity Directory Bind`
role. This specific permission is required to bind a Worker to an existing WVPC
Service. If you encounter a "binding" error during deployment, verify that your
user account or API token has been granted this role in the Cloudflare
Dashboard.

Now that the configuration and secrets are in place, deploy the fully functional
Worker:

```bash
npx wrangler types
npx wrangler deploy
```

## 💻 Client Configuration

Ensure you have the **Cloudflare WARP Client** installed and enrolled in your
organization's Zero Trust team.

To connect `kubectl` to this worker, you do not need to install plugins. You
simply update your `~/.kube/config` to point to the Worker's public URL.

```yaml
apiVersion: v1
clusters:
- cluster:
    server: https://kube.mydomain.com
  name: cloudflare-k8s
contexts:
- context:
    cluster: cloudflare-k8s
    user: warp-user
  name: cf-context
current-context: cf-context
users:
- name: warp-user
  user:
    # No auth needed here; WARP handles the Session identity at 
    # the transport layer and the Worker maps your Access identity
    # to Kubernetes RBAC.
    token: "unused"
```

**The Authentication Flow:**
1.  Run your first command (e.g., `kubectl get pods`).
2.  **The request will likely hang or fail.** This is normal.
3.  Check your device for a **Cloudflare WARP push notification** (or open the
    WARP client manually). You will be prompted to re-authenticate with your
    Identity Provider (IdP) to prove your identity.
4.  Once you successfully log in via your browser, the WARP session is
    established.
5.  **Re-run the command.** It will now succeed.

*Note: You will only need to repeat this re-authentication step when your WARP
session expires, based on the session duration configured in your Zero Trust
dashboard.*

## 📊 Logging & Observability

For debugging and auditing purposes, you can configure the Worker to emit
detailed logs. This configuration is controlled by two variables in your
`wrangler.toml`.

### Configuration

By default, the Worker is configured for production safety: logging is set to
`info` and explicit Kubernetes request tracing is **disabled**.

```toml
# wrangler.toml

[vars]
# 1. Master toggle for K8s Audit Logs (Default: "false")
# If "true", logs details about every K8s request (Method, URL, Impersonated User, etc.).
# Requires LOG_LEVEL to be "info" or "debug".
ENABLE_K8S_LOGGING = "false"

# 2. Verbosity Level (Default: "info")
# Options: "debug" > "info" > "warn" > "error"
# Setting this to "info" will log Info, Warn, and Error messages, but suppress Debug.
LOG_LEVEL = "info"
```

### `LOG_LEVEL`

The `LOG_LEVEL` follows standard logging verbosity.

* **`debug`**: Highest verbosity. Logs everything, including potentially
  sensitive data.
* **`info`**: Standard operational logs. **Required** if you want to see the
  output from `ENABLE_K8S_LOGGING`.
* **`warn`** / **`error`**: Only logs issues and failures.

**Note:** If you set `ENABLE_K8S_LOGGING = "true"` but leave `LOG_LEVEL =
"error"`, you will **not** see the k8s audit logs because they are emitted at
the `info` level.

> **⚠️ Security Warning: Sensitive Data**
>
>Be extremely careful when increasing log verbosity in a production environment:
>
>1. **`ENABLE_K8S_LOGGING = "true"`**: This exposes the **exact resource paths**
>   (`/api/v1/secrets`) and **user identities** (e.g., `User: alice`, `Groups: system:masters`)
>   being impersonated. This is sensitive audit data.
>2. **`LOG_LEVEL = "debug"`**: This may dump raw request headers, internal logic
>   states, or payload fragments.
>
>Ensure you treat these logs as sensitive data. We recommend sanitizing them or
>using secure destinations if you are piping them to external systems.

### Enterprise Analytics (Logpush)

For production environments, we strongly recommend enabling **Cloudflare
Logpush**. This allows you to stream your Worker's logs to a persistent storage
destination (like **Cloudflare R2**, S3, Datadog, or Splunk) for long-term
retention and security analysis.

* **Setup:** Go to your Cloudflare Dashboard > Analytics & Logs > Logpush.
* **Destinations:** We recommend using [Cloudflare R2](https://developers.cloudflare.com/r2/) for a cost-effective, S3-compatible storage solution.
* **Documentation:** [Read the full Logpush guide](https://developers.cloudflare.com/logs/about/).
