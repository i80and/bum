import typescript from 'rollup-plugin-typescript'

export default {
    entry: './src/main.ts',
    dest: 'build/app.js',
    format: 'iife',

    plugins: [
        typescript()
    ]
}
