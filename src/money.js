function parseRupeesToPaise(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Enter a valid amount with up to two decimal places.');
  const [rupees, fraction = ''] = text.split('.');
  const paise = Number(rupees) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(paise) || paise <= 0) throw new Error('Amount must be greater than zero and within the supported range.');
  return paise;
}

function allocateShares(amountPaise, participantIds) {
  const ids = [...new Set(participantIds)].sort((a, b) => a - b);
  if (!ids.length) throw new Error('Select at least one participant.');
  const base = Math.floor(amountPaise / ids.length);
  let remainder = amountPaise % ids.length;
  return ids.map(userId => ({ userId, sharePaise: base + (remainder-- > 0 ? 1 : 0) }));
}

module.exports = { parseRupeesToPaise, allocateShares };
