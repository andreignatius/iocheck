#!/usr/bin/env bash
# M3 verification: cluster state + functional endpoints + NetworkPolicy segmentation.
# Requires the app deployed to kind (make deploy).
set -uo pipefail
NS=iocheck
say() { printf '\n== %s ==\n' "$1"; }

say "nodes"; kubectl get nodes
say "pods (-o wide: iocheck should spread across nodes §O5)"; kubectl get pods -n $NS -o wide
say "pdb (ALLOWED DISRUPTIONS 0 = zero eviction budget by design §O4)"; kubectl get pdb -n $NS
say "networkpolicies (§S5)"; kubectl get networkpolicy -n $NS

say "functional check via port-forward"
kubectl -n $NS port-forward svc/iocheck 8080:3000 >/tmp/pf_verify.log 2>&1 &
PF=$!; sleep 4
BASE=http://localhost:8080; ct='content-type: application/json'
echo -n "healthz: "; curl -fsS $BASE/healthz; echo
echo -n "readyz:  "; curl -fsS $BASE/readyz; echo
echo -n "lookup seeded IP: "; curl -fsS -XPOST $BASE/lookup -H "$ct" -d '{"type":"ip","value":"203.0.113.7"}'; echo
kill $PF 2>/dev/null || true

say "NetworkPolicy segmentation: a NON-iocheck pod → datastores MUST be BLOCKED (§S5)"
kubectl apply -f - <<'EOF' >/dev/null 2>&1
apiVersion: v1
kind: Pod
metadata: { name: netcheck, namespace: iocheck, labels: { app: netcheck } }
spec:
  restartPolicy: Never
  securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: netcheck
      image: busybox:1.36
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
      command: ["sh","-c","nc -w3 -z postgres 5432 && echo 'postgres:5432 REACHED' || echo 'postgres:5432 BLOCKED'; nc -w3 -z redis 6379 && echo 'redis:6379 REACHED' || echo 'redis:6379 BLOCKED'"]
EOF
kubectl -n $NS wait --for=jsonpath='{.status.phase}'=Succeeded pod/netcheck --timeout=30s >/dev/null 2>&1
kubectl -n $NS logs netcheck
kubectl -n $NS delete pod netcheck --now >/dev/null 2>&1

echo; echo "k8s verification complete."
