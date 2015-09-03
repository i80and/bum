.PHONY: all clean

all: ./build/app.js ./build/index.html

./.obj/%.js: ./src/%.ts
	./node_modules/.bin/tsc --noImplicitAny --target es6 --outDir ./.obj $^

./build/app.js: ./.obj/*.js
	./node_modules/.bin/browserify -o $@ -e ./.obj/main.js -t [ babelify ]

./build/index.html: index.html
	cp $^ $@

clean:
	rm -r .obj/*
	rm -r build/*
