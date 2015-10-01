.PHONY: all clean

SRC=./src/main.ts ./src/media.ts

all: ./build/app.js ./build/index.html
	rsync -ra --delete style/ build/style

./build/app.js: $(SRC)
	./node_modules/.bin/tsc --noImplicitAny --target es6 --outDir ./.obj $^
	./node_modules/.bin/browserify -o $@ -e ./.obj/main.js -t [ babelify ]

./build/index.html: index.html
	cp $^ $@

clean:
	rm -r .obj/*
	rm -r build/*
