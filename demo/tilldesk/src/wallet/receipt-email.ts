const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

function formatPaise(amountPaise: number): string {
  return inr.format(amountPaise / 100);
}

export function receiptSubject(amountPaise: number): string {
  return `Your Tilldesk wallet was topped up with ${formatPaise(amountPaise)}`;
}

export function receiptBody(amountPaise: number): string {
  return [
    'Hello,',
    '',
    `We received your top-up of ${formatPaise(amountPaise)}. It has been added to your Tilldesk wallet.`,
    '',
    'Thank you,',
    'Tilldesk',
  ].join('\n');
}
