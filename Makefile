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
VERSION := 0.1.0
IMAGE := iocheck:$(VERSION)          # versioned tag, NOT :latest (concern #5)
NS := iocheck

.PHONY: cluster-up cluster-down calico k8s-image kind-load secret deploy undeploy cluster-status

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
