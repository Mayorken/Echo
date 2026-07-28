const { expect } = require('chai');
const { BillingLedger } = require('../lib/billingLedger');

describe('lib/billingLedger.js', function () {
  let ledger;

  beforeEach(function () {
    ledger = new BillingLedger();
  });

  it('activates a paid storage credit exactly once', function () {
    ledger.begin({
      paymentIntentId: 'pi_123',
      userAddress: '0xABC',
      plan: 'plus',
      creditCents: 1500,
    });
    ledger.transition('pi_123', 'provisioning');
    ledger.transition('pi_123', 'active', { provisioningReceipt: 'reserve:1' });
    ledger.transition('pi_123', 'active');

    const account = ledger.getAccount('0xabc');
    expect(account.creditCents).to.equal(1500);
    expect(account.payments[0].state).to.equal('active');
    expect(account.payments[0].attempts).to.equal(1);
  });

  it('is idempotent when Stripe delivers the same payment twice', function () {
    ledger.begin({
      paymentIntentId: 'pi_repeat',
      userAddress: '0xabc',
      plan: 'starter',
      creditCents: 500,
    });
    const duplicate = ledger.begin({
      paymentIntentId: 'pi_repeat',
      userAddress: '0xdifferent',
      plan: 'team',
      creditCents: 4000,
    });

    expect(duplicate.userAddress).to.equal('0xabc');
    expect(ledger.getAccount('0xabc').payments).to.have.length(1);
  });

  it('tracks retry and refund transitions without granting credit', function () {
    ledger.begin({
      paymentIntentId: 'pi_failed',
      userAddress: '0xabc',
      plan: 'starter',
      creditCents: 500,
    });
    ledger.transition('pi_failed', 'provisioning');
    ledger.transition('pi_failed', 'retrying', { error: 'treasury unavailable' });
    ledger.transition('pi_failed', 'refund_pending');
    ledger.transition('pi_failed', 'refunded');

    expect(ledger.getPayment('pi_failed').state).to.equal('refunded');
    expect(ledger.getAccount('0xabc').creditCents).to.equal(0);
  });

  it('rejects unsafe state jumps', function () {
    ledger.begin({
      paymentIntentId: 'pi_bad',
      userAddress: '0xabc',
      plan: 'starter',
      creditCents: 500,
    });
    expect(() => ledger.transition('pi_bad', 'active')).to.throw(
      'Invalid billing transition payment_received -> active',
    );
  });
});
