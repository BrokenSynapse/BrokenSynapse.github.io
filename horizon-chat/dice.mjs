import { randomInt } from 'node:crypto';

const supported = new Set([2, 4, 6, 8, 10, 12, 20, 100]);

export function rollDice(input) {
  const source = typeof input.expression === 'string' ? input.expression.replace(/\s+/g, '').toLowerCase()
    : supported.has(input.sides) ? '1d' + input.sides : '';
  if (!source || source.length > 160 || !/^(?:[1-9]\d*)?d\d+(?:\+(?:[1-9]\d*)?d\d+)*$/.test(source)) {
    throw new Error('Enter dice such as 2d6+1d20.');
  }
  const groups = source.split('+').map(part => {
    const [amount, faces] = part.split('d');
    return { count: Number(amount || 1), sides: Number(faces) };
  });
  if (groups.some(group => !supported.has(group.sides)) ||
      groups.reduce((sum, group) => sum + group.count, 0) > 50) {
    throw new Error('Choose D2, D4, D6, D8, D10, D12, D20, or D100, up to 50 dice per roll.');
  }
  const dice = groups.flatMap(group => Array.from({ length: group.count },
    () => ({ sides: group.sides, result: randomInt(1, group.sides + 1) })));
  return { kind: 'dice', expression: groups.map(group => group.count + 'd' + group.sides).join('+'),
    dice, total: dice.reduce((sum, die) => sum + die.result, 0) };
}
