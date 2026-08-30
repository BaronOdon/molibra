#!/usr/bin/env bash
#
# Launch an Oracle Cloud Always Free ARM instance, retrying past the capacity
# errors that make this a two-day job by hand.
#
#   bash deploy/oracle-launch.sh
#
# ⛔ "Out of host capacity" on VM.Standard.A1.Flex is NOT a mistake you made.
# Ampere capacity in the free tier is genuinely scarce and frees up irregularly.
# The console gives you one attempt per click; this gives you one every 60
# seconds across every availability domain, which is the whole reason it exists.
#
# ---------------------------------------------------------------- prerequisites
#
# 1. Install the OCI CLI:
#      bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"
#
# 2. Configure it YOURSELF:
#      oci setup config
#
#    ⛔ Run that yourself and keep the key. It generates an API signing key,
#    and that private key is a credential for your whole tenancy. This script
#    never reads it, never prints it, and never sends it anywhere - it only
#    calls the CLI you have already configured.
#
# 3. Upload the generated public key in the console:
#      Profile -> My profile -> API keys -> Add API key
#
# Set the four values below, then run. Every OCID is visible in the console.

set -euo pipefail

: "${COMPARTMENT_OCID:?set COMPARTMENT_OCID (Identity -> Compartments, or your tenancy OCID)}"
: "${SUBNET_OCID:?set SUBNET_OCID (Networking -> VCN -> Subnets)}"
: "${SSH_PUBLIC_KEY:=$HOME/.ssh/id_rsa.pub}"

SHAPE="${SHAPE:-VM.Standard.A1.Flex}"
OCPUS="${OCPUS:-4}"
MEMORY_GB="${MEMORY_GB:-24}"
DISPLAY_NAME="${DISPLAY_NAME:-molibra-node}"
RETRY_SECONDS="${RETRY_SECONDS:-60}"
MAX_TRIES="${MAX_TRIES:-1000}"

[ -f "$SSH_PUBLIC_KEY" ] || { echo "no public key at $SSH_PUBLIC_KEY - ssh-keygen first" >&2; exit 1; }
command -v oci >/dev/null 2>&1 || { echo "the OCI CLI is not installed - see the header" >&2; exit 1; }

echo "==> Finding the newest Ubuntu 22.04 image for ${SHAPE}"
IMAGE_OCID=$(oci compute image list \
  --compartment-id "$COMPARTMENT_OCID" \
  --operating-system "Canonical Ubuntu" \
  --operating-system-version "22.04" \
  --shape "$SHAPE" \
  --sort-by TIMECREATED --sort-order DESC \
  --query 'data[0].id' --raw-output)
[ -n "$IMAGE_OCID" ] || { echo "no image found for shape $SHAPE" >&2; exit 1; }
echo "    $IMAGE_OCID"

echo "==> Availability domains"
mapfile -t ADS < <(oci iam availability-domain list \
  --compartment-id "$COMPARTMENT_OCID" --query 'data[*].name' --raw-output \
  | tr -d '[]"," ' | grep -v '^$')
printf '    %s\n' "${ADS[@]}"

echo
echo "==> Launching. Ctrl-C to stop; capacity frees up irregularly, often overnight."
echo

try=0
while [ "$try" -lt "$MAX_TRIES" ]; do
  for AD in "${ADS[@]}"; do
    try=$((try + 1))
    printf '[%s] attempt %d in %s ... ' "$(date +%H:%M:%S)" "$try" "$AD"

    if OUT=$(oci compute instance launch \
        --availability-domain "$AD" \
        --compartment-id "$COMPARTMENT_OCID" \
        --shape "$SHAPE" \
        --shape-config "{\"ocpus\":${OCPUS},\"memoryInGBs\":${MEMORY_GB}}" \
        --subnet-id "$SUBNET_OCID" \
        --image-id "$IMAGE_OCID" \
        --display-name "$DISPLAY_NAME" \
        --assign-public-ip true \
        --ssh-authorized-keys-file "$SSH_PUBLIC_KEY" \
        --wait-for-state RUNNING 2>&1); then

      ID=$(echo "$OUT" | grep -o '"id": "ocid1.instance[^"]*"' | head -1 | cut -d'"' -f4)
      echo "LAUNCHED"
      echo
      echo "    instance: $ID"
      IP=$(oci compute instance list-vnics --instance-id "$ID" \
             --query 'data[0]."public-ip"' --raw-output 2>/dev/null || echo '')
      echo "    public IP: ${IP:-<check the console>}"
      cat <<NEXT

Next, and both are needed - Oracle has TWO firewalls:

  1. Console: Networking -> VCN -> Security Lists -> Default
     Ingress: source 0.0.0.0/0, TCP, destination port 8545

  2. On the instance:
     ssh ubuntu@${IP:-<ip>}
     curl -fsSL https://raw.githubusercontent.com/BaronOdon/molibra/main/deploy/install.sh | bash

NEXT
      exit 0
    fi

    # Capacity is the expected failure. Anything else is a real error and
    # retrying it forever would just hide the message.
    if echo "$OUT" | grep -qi "out of host capacity\|OutOfCapacity\|LimitExceeded"; then
      echo "no capacity"
    else
      echo "FAILED"
      echo
      echo "$OUT" | head -20
      echo
      echo "That is not a capacity error, so retrying will not help. Fix it and re-run." >&2
      exit 1
    fi
  done
  sleep "$RETRY_SECONDS"
done

echo "Gave up after $try attempts." >&2
exit 1
