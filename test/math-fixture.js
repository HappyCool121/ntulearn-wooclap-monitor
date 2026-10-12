// Synthetic quiz data for exercising KaTeX's duplicate DOM representations.
const math = (mrow, tex) => `<span class="katex-display"><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow>${mrow}</mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">DUPLICATE_VISUAL_MATH</span></span></span>`;
const x = math('<mi>x</mi>', 'x');
const y = math('<mi>y</mi>', 'y');
const z = math('<mi>z</mi>', 'z');
const square = math('<msup><mi>x</mi><mn>2</mn></msup><mo>=</mo><mn>16</mn>', 'x^2=16');
const sum = math('<mi>x</mi><mo>+</mo><mi>y</mi><mo>=</mo><mn>10</mn>', 'x+y=10');
const range = math('<mn>0</mn><mo>&lt;</mo><mi>x</mi><mo>≤</mo><mn>5</mn>', '0&lt;x\\le5');
const answer = math('<mi>x</mi><mo>=</mo><mn>4</mn>', 'x=4');
export const mathQuestionHTML = `<main><h1><span>A sample algebra exercise gives ${square}, ${sum}, and ${range}. Which statement identifies ${x}?</span></h1><div role="radiogroup"><div role="radio">${x} is greater than ten</div><div role="radio">${x} must equal ${z}</div><div role="radio">${y} must equal ${x}</div><div role="radio">${answer}</div></div><button>Submit</button></main>`;
