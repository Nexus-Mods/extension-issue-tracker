const COMPLIMENTS = [
  'You look lovely today!',
  'You\'re amazing!',
  'You are one of a kind!',
  'You know that guy in scary movies who is like, "Hey, let\'s split up"? that guy is dumb, you\'re not that guy!',
];

export function getCompliment() {
  return COMPLIMENTS[Math.floor(Math.random() * COMPLIMENTS.length)];
}
