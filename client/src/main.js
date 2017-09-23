import * as media from './media'
import AlbumsView from './components/AlbumsView.html'

const EMPTY_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP'

class Player {
    constructor(library) {
        this.playing = null
        this.paused = null
        this.library = library
        this.playlist = []
        this.playlistPosition = 0
        this.onplay = () => {}

        this._initElement()
    }

    play(songs) {
        this.playlist = songs
        this.doPlay(0)
    }

    togglePause() {
        if(this.paused) {
            this.element.play()
            this.playing = this.paused
            this.paused = null
            this.onplay()
            return
        }

        this.element.pause()
        this.paused = this.playing
        this.playing = null
        this.onplay()
    }

    skip() {
        this.doPlay(1)
    }

    back() {
        if (!this.element) {
            return
        }

        if (this.element.currentTime >= 4 || this.playlistPosition === 0) {
            this.element.currentTime = 0
        } else {
            this.doPlay(-1)
        }
    }

    shuffle() {
        this.library.shuffle().then((ids) => ids.map((id) => {
            return this.library.getSong(id)
        })).then((songs) => {
            this.play(songs)
        })
    }

    doPlay(skipNumber) {
        this.paused = null
        this.playing = null
        if(this.playlistPosition >= this.playlist.length) {
            this.onplay()

            // Don't pause an errored stream. This can cause a nasty
            // error loop, where pausing triggers reparsing bad input.
            if(!this.element.error) {
                this.element.pause()
            }
            return
        }

        this.playlistPosition += skipNumber
        const song = this.playlist[this.playlistPosition]
        this.playing = song
        this.element.src = this.library.songUrl(song)
        this.element.play()

        this.onplay()
    }

    _initElement() {
        this.element = document.createElement('audio')
        this.element.controls = false

        this.element.onended = () => {
            this.doPlay(1)
        }

        this.element.onerror = () => {
            const id = this.playing? this.playing.id : 'unknown'
            console.error(`Error playing ${id}`)
            this.doPlay(1)
        }
    }
}

class CoverSwitcher {
    constructor(elements) {
        this.elements = elements.slice(0, 2)
        this.curCover = null
        this.cur = 0
    }

    switch(url) {
        if(url === this.curCover) { return }

        this.curCover = url

        this.currentElement.classList.add('old')
        this.cur = (this.cur + 1) % 2
        this.currentElement.classList.remove('old')

        if(url === null) {
            this.currentElement.src = EMPTY_IMAGE
            return
        }

        this.currentElement.src = url
    }

    get currentElement() {
        return this.elements[this.cur]
    }
}

function main() {
    const backButton = document.getElementById('back-button')
    const playButton = document.getElementById('play-button')
    const skipButton = document.getElementById('skip-button')
    const labelElement = document.getElementById('caption')

    const coverSwitcher = new CoverSwitcher(Array.from(document.getElementsByClassName('cover')))
    const library = new media.MediaLibrary('/api')
    const player = new Player(library)

    library.refresh()

    player.onplay = () => {
        const song = player.playing || player.paused

        if(song) {
            labelElement.textContent = `${song.artist} - ${song.title}`

            library.getAlbumBySong(song.id).then((album) => {
                coverSwitcher.switch(library.getCover(album))
            })
        } else {
            coverSwitcher.switch(null)
            labelElement.textContent = ''
        }

        if(player.playing) {
            playButton.className = 'fa fa-pause playing'
        } else {
            playButton.className = 'fa fa-play'
        }
    }

    backButton.addEventListener('click', function() {
        player.back()
    })

    playButton.addEventListener('click', function() {
        if(player.playing) {
            player.togglePause()
        } else if(player.paused) {
            player.togglePause()
        } else {
            player.shuffle()
        }
    })

    skipButton.addEventListener('click', function() {
        player.skip()
    })

    const albumsButton = document.getElementById('albums-button')
    const albumsView = new AlbumsView({
        target: document.getElementById('album-list'),
        data: { library }
    })

    albumsView.on('shuffle', () => {
        player.shuffle()
        albumsView.set({ show: false })
    })

    albumsView.on('select', (album) => {
        const songs = album.tracks.map((id) => {
            return library.getSong(id)
        })

        player.play(songs)
        albumsView.set({ show: false })
    })

    albumsButton.addEventListener('click', function() {
        albumsView.set({ show: !albumsView.get('show') })
    })
}

window.addEventListener('DOMContentLoaded', function() {
    main()
})
