# iocheck — dev, build & run targets. `make help` lists everything.
.DEFAULT_GOAL := help
.PHONY: help install typecheck test build up down restart logs ps smoke clean

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n",$$1,$$2}'

install: ## Install node deps (npm ci)
	npm ci

typecheck: ## Typecheck with tsc (no emit)
	npm run typecheck

test: ## Run unit tests
	npm test

build: ## Build the service image
	docker compose build

up: ## Start the stack (service + postgres + redis), rebuilding the image
	docker compose up -d --build

down: ## Stop the stack
	docker compose down

restart: ## Recreate just the service
	docker compose up -d --build iocheck

logs: ## Tail service logs
	docker compose logs -f iocheck

ps: ## Show stack status + health
	docker compose ps

smoke: ## Fire example requests at the running stack
	./scripts/smoke.sh

clean: ## Stop and REMOVE volumes (fresh DB next up)
	docker compose down -v

# ---- Kubernetes (kind) — M3+ -------------------------------------------------
CLUSTER := iocheck
VERSION := 0.1.5
IMAGE := iocheck:$(VERSION)          # versioned tag, NOT :latest (concern #5)
NS := iocheck

.PHONY: cluster-up cluster-down calico k8s-image kind-load secret deploy undeploy cluster-status

# Order matters: observability installs the KEDA CRD BEFORE deploy applies the ScaledObject.
all: cluster-up calico observability deploy ## FULL clean spin-up: cluster + CNI + monitoring/KEDA, THEN app
	@echo ""
	@echo "iocheck is up. Next:"
	@echo "  make loadtest        # drive the alert-storm load"
	@echo "  make grafana-open    # dashboards at http://localhost:3001/d/iocheck-overview"
	@echo "  make cluster-status  # nodes + pods"

cluster-up: ## Create the multi-node kind cluster (no CNI yet)
	kind create cluster --config k8s/kind-config.yaml

calico: ## Install Calico CNI from the VENDORED manifest (enforces NetworkPolicy; nodes go Ready)
	kubectl apply -f k8s/calico-v3.28.2.yaml
	kubectl -n kube-system rollout status ds/calico-node --timeout=180s

k8s-image: ## Build the service image with a versioned tag
	docker build -t $(IMAGE) .

kind-load: k8s-image ## Build + load the image into the kind nodes (no registry needed)
	kind load docker-image $(IMAGE) --name $(CLUSTER)

secret: ## Create the k8s Secret from .env values (never committed, §S2)
	@set -a; . ./.env; set +a; \
	kubectl create secret generic iocheck-secrets -n $(NS) \
	  --from-literal=postgres-super-password="$$POSTGRES_SUPER_PASSWORD" \
	  --from-literal=app-db-password="$$APP_DB_PASSWORD" \
	  --from-literal=redis-password="$$REDIS_PASSWORD" \
	  --from-literal=ioc-admin-api-key="$$IOC_ADMIN_API_KEY" \
	  --dry-run=client -o yaml | kubectl apply -f -

deploy: kind-load ## Load image, create ns/secret/init-configmap, apply manifests, wait for rollout
	kubectl apply -f k8s/manifests/00-namespace.yaml
	$(MAKE) secret
	kubectl create configmap iocheck-pg-init -n $(NS) --from-file=init.sh=db/init.sh \
	  --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -f k8s/manifests/
	kubectl -n $(NS) rollout status deploy/iocheck --timeout=180s

undeploy: ## Delete the app namespace (everything in it)
	kubectl delete namespace $(NS) --ignore-not-found

cluster-status: ## Show nodes + all pods
	kubectl get nodes -o wide && echo && kubectl get pods -A

cluster-down: ## Delete the kind cluster
	kind delete cluster --name $(CLUSTER)

# ---- Observability (M4) ------------------------------------------------------
.PHONY: metrics-server prometheus grafana observability grafana-open prometheus-open

metrics-server: ## Install metrics-server (vendored, patched with --kubelet-insecure-tls)
	kubectl apply -f k8s/metrics-server-v0.7.2.yaml
	kubectl -n kube-system rollout status deploy/metrics-server --timeout=120s

prometheus: ## Deploy minimal Prometheus (scrapes iocheck)
	kubectl apply -f k8s/monitoring/00-namespace.yaml
	kubectl apply -f k8s/monitoring/10-prometheus.yaml
	kubectl -n monitoring rollout status deploy/prometheus --timeout=120s

grafana: ## Deploy Grafana with provisioned datasource + dashboard-as-code
	kubectl apply -f k8s/monitoring/00-namespace.yaml
	kubectl create configmap grafana-dashboard-iocheck -n monitoring \
	  --from-file=iocheck-overview.json=k8s/monitoring/grafana-dashboards/iocheck-overview.json \
	  --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -f k8s/monitoring/20-grafana.yaml
	kubectl -n monitoring rollout status deploy/grafana --timeout=120s

keda: ## Install KEDA (vendored) — autoscaler for M6
	kubectl apply --server-side -f k8s/keda-2.17.1.yaml
	kubectl -n keda rollout status deploy/keda-operator --timeout=150s

observability: metrics-server prometheus grafana keda ## Install the whole M4 stack

grafana-open: ## Port-forward Grafana to localhost:3001 (admin/admin)
	@echo "Grafana: http://localhost:3001  (anonymous viewer enabled)"
	kubectl -n monitoring port-forward svc/grafana 3001:3000

prometheus-open: ## Port-forward Prometheus to localhost:9090
	kubectl -n monitoring port-forward svc/prometheus 9090:9090

# ---- Load test (M5/M6) -------------------------------------------------------
.PHONY: loadtest loadtest-logs loadtest-clean

loadtest: ## Run the k6 storm Job (in-cluster, hits the Service). Re-runnable.
	kubectl apply -f k8s/loadtest/00-namespace.yaml
	kubectl create configmap k6-scripts -n loadtest \
	  --from-file=lookup-storm.js=k8s/loadtest/lookup-storm.js \
	  --dry-run=client -o yaml | kubectl apply -f -
	kubectl -n loadtest delete job k6-storm --ignore-not-found
	kubectl apply -f k8s/loadtest/10-k6-job.yaml
	@echo "started. follow with: make loadtest-logs"

loadtest-logs: ## Follow the running k6 Job logs
	kubectl -n loadtest wait --for=condition=ready pod -l app=k6-storm --timeout=60s || true
	kubectl -n loadtest logs -f job/k6-storm

loadtest-clean: ## Remove the load-test namespace
	kubectl delete namespace loadtest --ignore-not-found
