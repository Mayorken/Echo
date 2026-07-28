const TERMINAL_STATES = new Set(['active', 'refunded']);
const ALLOWED_TRANSITIONS = {
  payment_received: new Set(['provisioning', 'refund_pending']),
  provisioning: new Set(['active', 'retrying', 'refund_pending']),
  retrying: new Set(['provisioning', 'refund_pending']),
  refund_pending: new Set(['refunded']),
  active: new Set(),
  refunded: new Set(),
};

class BillingLedger {
  constructor() {
    this.payments = new Map();
    this.balances = new Map();
  }

  begin({ paymentIntentId, userAddress, plan, creditCents }) {
    if (!paymentIntentId) throw new Error('paymentIntentId is required');
    if (!userAddress) throw new Error('userAddress is required');
    if (!Number.isInteger(creditCents) || creditCents <= 0) {
      throw new Error('creditCents must be a positive integer');
    }

    const existing = this.payments.get(paymentIntentId);
    if (existing) return { ...existing };

    const now = new Date().toISOString();
    const payment = {
      paymentIntentId,
      userAddress: userAddress.toLowerCase(),
      plan,
      creditCents,
      state: 'payment_received',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    this.payments.set(paymentIntentId, payment);
    return { ...payment };
  }

  transition(paymentIntentId, nextState, details = {}) {
    const payment = this.payments.get(paymentIntentId);
    if (!payment) throw new Error(`Unknown payment ${paymentIntentId}`);
    if (payment.state === nextState) return { ...payment };
    if (TERMINAL_STATES.has(payment.state)) return { ...payment };
    if (!ALLOWED_TRANSITIONS[payment.state].has(nextState)) {
      throw new Error(`Invalid billing transition ${payment.state} -> ${nextState}`);
    }

    payment.state = nextState;
    payment.updatedAt = new Date().toISOString();
    payment.error = details.error || null;
    if (nextState === 'provisioning') payment.attempts += 1;

    if (nextState === 'active' && !payment.creditedAt) {
      const current = this.balances.get(payment.userAddress) || 0;
      this.balances.set(payment.userAddress, current + payment.creditCents);
      payment.creditedAt = payment.updatedAt;
      payment.provisioningReceipt = details.provisioningReceipt || null;
    }

    return { ...payment };
  }

  getPayment(paymentIntentId) {
    const payment = this.payments.get(paymentIntentId);
    return payment ? { ...payment } : null;
  }

  getAccount(userAddress) {
    const normalized = userAddress.toLowerCase();
    const payments = [...this.payments.values()]
      .filter((payment) => payment.userAddress === normalized)
      .map((payment) => ({ ...payment }));
    return {
      userAddress: normalized,
      creditCents: this.balances.get(normalized) || 0,
      payments,
    };
  }
}

module.exports = { BillingLedger, ALLOWED_TRANSITIONS };
