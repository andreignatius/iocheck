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
IMAGE := iocheck-iocheck:latest

.PHONY: cluster-up cluster-down calico kind-load k8s-image cluster-status

cluster-up: ## Create the multi-node kind cluster (no CNI yet)
	kind create cluster --config k8s/kind-config.yaml

calico: ## Install Calico CNI from the VENDORED manifest (enforces NetworkPolicy; nodes go Ready)
	kubectl apply -f k8s/calico-v3.28.2.yaml
	kubectl -n kube-system rollout status ds/calico-node --timeout=180s

k8s-image: ## Build the service image for kind
	docker compose build iocheck

kind-load: k8s-image ## Load the service image into the kind nodes
	kind load docker-image $(IMAGE) --name $(CLUSTER)

cluster-status: ## Show nodes + all pods
	kubectl get nodes -o wide && echo && kubectl get pods -A

cluster-down: ## Delete the kind cluster
	kind delete cluster --name $(CLUSTER)
