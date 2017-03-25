.PHONY: all clean

SRC=./src/main.ts ./src/media.ts

all: ./build/index.html
	greni
	rsync -ra --delete style/ build/style

./build/index.html: index.html
	cp $^ $@

clean:
	rm -r build/*
