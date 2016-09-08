import typescript from 'rollup-plugin-typescript'
import uglify from 'rollup-plugin-uglify'
import { minify } from 'uglify-js'

export default {
    entry: './src/main.ts',
    dest: 'build/app.js',
    format: 'iife',

    plugins: [
        typescript(),
        uglify({}, minify)
    ]
}
